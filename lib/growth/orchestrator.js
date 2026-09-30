/**
 * Deterministic Growth stage orchestrator (research → qualify → critic).
 *
 * Library only: no routes, cron, discovery, outreach, or visibility quota.
 * Commercial Growth billing entitlements are not wired; this module enforces a
 * local AI call budget only (1 reasoner + 1 critic).
 */

import { aicreditsChatDetailed } from "../ai/aicredits.js";
import { collectStoreObservations, analyzeCollectedObservations } from "./research-collector.js";
import { buildEvidencePack } from "./evidence-pack.js";
import { qualifyProspect } from "./qualification-reasoner.js";
import { reviewQualification } from "./qualification-critic.js";
import { serializeQualificationForPersistence } from "./persistence.js";
import { hasGroundedReasons } from "./qualification-contract.js";
import { assertProspectTransition } from "./state-machine.js";
import { claimGrowthJob, GROWTH_JOB_LEASE_MS } from "./job-claim.js";
import {
  GROWTH_ERROR_CODES,
  classifyFailure,
  classifyResearchCollectionFailure,
  failJob,
  persistResearchSuccess,
  persistQualificationAndMaybeCriticJob,
  persistCriticSuccess,
  reconstructPackFromEvidence,
  resolveLifecycleFromReview,
  sanitizePersistedError,
} from "./persist-run.js";

/** Conservative bound for Growth reasoner/critic HTTP calls. Visibility defaults unchanged. */
export const GROWTH_AI_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.GROWTH_AI_TIMEOUT_MS) || 25_000
);

/** Local hard cap. Does not consume visibility aiTests quota. */
export const GROWTH_AI_BUDGET = Object.freeze({
  maxReasonerCalls: 1,
  maxCriticCalls: 1,
  maxTotalCalls: 2,
});

export { GROWTH_ERROR_CODES, GROWTH_JOB_LEASE_MS, claimGrowthJob };

const TYPE_ORDER = { research: 0, qualify: 1, critic: 2 };

export async function processGrowthProspect(input = {}) {
  const db = input.db;
  const now = asDate(input.now);
  const budget = input.budget || createGrowthAiBudget();
  const prospect = await loadProspect(db, input.campaignId, input.prospectId);
  await ensureResearchJob(db, prospect, now);

  const outcomes = [];
  for (let i = 0; i < 8; i += 1) {
    const job = await findClaimableJob(db, prospect.id, now);
    if (!job) break;
    const result = await processGrowthJob({ ...input, jobId: job.id, now, budget });
    outcomes.push(result);
    if (result.claim && result.claim !== "claimed" && result.status !== "already_complete") break;
    if (result.status === "failed" && result.retryable === false) break;
  }
  return { prospectId: prospect.id, campaignId: prospect.campaignId, outcomes, budget };
}

export async function processGrowthJob(input = {}) {
  const db = input.db;
  const now = asDate(input.now);
  const jobId = input.jobId;
  const existing = await db.growthJob.findUnique({ where: { id: jobId } });
  if (!existing) return { status: "missing", claim: "missing" };
  if (existing.status === "succeeded") {
    return { status: "already_complete", claim: "terminal", job: existing };
  }
  if (existing.status === "failed" || existing.status === "cancelled") {
    return { status: "already_complete", claim: "terminal", job: existing };
  }

  let job = existing;
  if (input.alreadyClaimed) {
    if (existing.status !== "running") {
      return { status: "not_started", claim: "already_claimed", job: existing };
    }
  } else {
    const claimed = await claimGrowthJob(db, jobId, { now, leaseMs: input.leaseMs });
    if (claimed.status !== "claimed") {
      return { status: "not_started", claim: claimed.status, job: claimed.job };
    }
    job = claimed.job;
  }
  const prospect = await db.growthProspect.findUnique({ where: { id: job.prospectId } });
  const campaign = await db.growthCampaign.findUnique({ where: { id: job.campaignId } });
  if (!prospect || !campaign) {
    await db.$transaction((tx) =>
      failJob(tx, {
        job,
        prospect,
        fromLifecycle: prospect?.lifecycleState,
        toLifecycle: prospect ? "failed" : null,
        code: GROWTH_ERROR_CODES.ILLEGAL_STATE,
        message: "missing_prospect_or_campaign",
        now,
      })
    );
    return { status: "failed", claim: "claimed", errorCode: GROWTH_ERROR_CODES.ILLEGAL_STATE, retryable: false };
  }

  try {
    if (job.type === "research") return await runResearch({ ...input, db, job, prospect, campaign, now });
    if (job.type === "qualify") return await runQualify({ ...input, db, job, prospect, campaign, now, budget: input.budget });
    if (job.type === "critic") return await runCritic({ ...input, db, job, prospect, campaign, now, budget: input.budget });
    await failStage(db, { job, prospect, now, err: Object.assign(new Error("unknown_job_type"), { code: GROWTH_ERROR_CODES.ILLEGAL_STATE }), stage: "qualify" });
    return { status: "failed", claim: "claimed", errorCode: GROWTH_ERROR_CODES.ILLEGAL_STATE, retryable: false };
  } catch (err) {
    return failStage(db, { job, prospect, now, err, stage: job.type === "research" ? "research" : job.type === "critic" ? "critic" : "qualify" });
  }
}

async function runResearch({ db, job, prospect, now, fetchFn }) {
  let current = prospect;
  if (current.lifecycleState === "candidate") {
    await transitionProspect(db, current, "research_pending");
    current = { ...current, lifecycleState: "research_pending" };
  }
  if (current.lifecycleState === "research_pending") {
    await transitionProspect(db, current, "researching");
    current = { ...current, lifecycleState: "researching" };
  }
  if (current.lifecycleState !== "researching" && current.lifecycleState !== "researched") {
    return failStage(db, {
      job,
      prospect: current,
      now,
      err: Object.assign(new Error("illegal_research_lifecycle"), { code: GROWTH_ERROR_CODES.ILLEGAL_STATE }),
      stage: "research",
    });
  }

  const collection = await collectStoreObservations({
    url: current.normalizedUrl || current.originalUrl,
    fetchFn,
  });
  if (!collection.ok) {
    const classified = classifyResearchCollectionFailure(collection);
    const code = classified.code;
    await db.$transaction((tx) =>
      failJob(tx, {
        job,
        prospect: current,
        fromLifecycle: current.lifecycleState,
        toLifecycle: code === GROWTH_ERROR_CODES.RESEARCH_TIMEOUT ? "research_pending" : "failed",
        code,
        message: collection.error,
        now,
      })
    );
    return {
      status: "failed",
      claim: "claimed",
      errorCode: code,
      retryable: Boolean(classified.retryable),
      rootAttempts: collection.failure?.rootAttempts ?? collection.root?.rootAttempts ?? null,
      variantAttempted: Boolean(collection.failure?.variantAttempted || collection.root?.variantAttempted),
    };
  }

  const analysis = analyzeCollectedObservations(collection);
  const pack = buildEvidencePack({ collection, analysis });
  const persisted = await db.$transaction((tx) =>
    persistResearchSuccess(tx, { job, prospect: current, pack, now })
  );
  return {
    status: "succeeded",
    claim: "claimed",
    stage: "research",
    runId: persisted.runId,
    evidenceCount: persisted.evidenceCount,
    nextJobId: persisted.qualifyJob?.id || null,
    warnings: collection.warnings || [],
  };
}

async function runQualify({ db, job, prospect, campaign, now, chatFn, detailedChatFn, timeoutMs, budget: sharedBudget }) {
  if (prospect.lifecycleState === "qualification_pending") {
    await transitionProspect(db, prospect, "qualifying");
    prospect = { ...prospect, lifecycleState: "qualifying" };
  }
  if (prospect.lifecycleState !== "qualifying") {
    return failStage(db, {
      job,
      prospect,
      now,
      err: Object.assign(new Error("illegal_qualify_lifecycle"), { code: GROWTH_ERROR_CODES.ILLEGAL_STATE }),
      stage: "qualify",
    });
  }

  const researchJob = await db.growthJob.findFirst({
    where: { prospectId: prospect.id, type: "research", status: "succeeded" },
    orderBy: { finishedAt: "desc" },
  });
  if (!researchJob) {
    return failStage(db, {
      job,
      prospect,
      now,
      err: Object.assign(new Error("missing_research_run"), { code: GROWTH_ERROR_CODES.QUALIFICATION_INVALID }),
      stage: "qualify",
    });
  }
  const runId = researchJob.id;
  const runRows = await db.growthEvidence.findMany({
    where: { prospectId: prospect.id, runId },
  });
  const pack = reconstructPackFromEvidence(prospect, runRows);
  const productProfile = campaignToProfile(campaign);
  const budget = sharedBudget || createGrowthAiBudget();
  const reasonerChat = wrapBudgetedChat({
    chatFn,
    detailedChatFn,
    timeoutMs: timeoutMs ?? GROWTH_AI_TIMEOUT_MS,
    budget,
    stage: "reasoner",
  });

  const reasoner = await qualifyProspect({
    pack,
    productProfile,
    chatFn: reasonerChat,
    maxAttempts: 1,
  });
  if (!reasoner.ok) {
    const classified = classifyFailure({ message: reasoner.error, code: reasoner.error }, "qualify");
    return failStage(db, {
      job,
      prospect,
      now,
      err: Object.assign(new Error(reasoner.error || "qualification_failed"), { code: classified.code }),
      stage: "qualify",
    });
  }

  const usage = {
    ...reasoner.usage,
    model: budget.lastModel || reasoner.usage?.model,
    promptTokens: budget.lastUsage?.prompt_tokens ?? reasoner.usage?.promptTokens,
    completionTokens: budget.lastUsage?.completion_tokens ?? reasoner.usage?.completionTokens,
    totalTokens: budget.lastUsage?.total_tokens ?? reasoner.usage?.totalTokens,
    llmCalls: budget.reasonerCalls,
  };
  const serialized = serializeQualificationForPersistence({
    status: reasoner.shortCircuited ? "reject" : "needs_review",
    qualification: reasoner.qualification,
    reasoner: { ...reasoner, usage },
    reasonerProvider: reasoner.shortCircuited ? null : "aicredits",
    shortCircuited: reasoner.shortCircuited,
  });
  if (!serialized.qualification.structuralOk && !reasoner.ok) {
    return failStage(db, {
      job,
      prospect,
      now,
      err: Object.assign(new Error("QUALIFICATION_INVALID"), { code: GROWTH_ERROR_CODES.QUALIFICATION_INVALID }),
      stage: "qualify",
    });
  }

  try {
    const persisted = await db.$transaction((tx) =>
      persistQualificationAndMaybeCriticJob(tx, {
        job,
        prospect,
        serialized,
        runRows,
        now,
        needsCritic: !reasoner.shortCircuited,
      })
    );
    return {
      status: "succeeded",
      claim: "claimed",
      stage: "qualify",
      qualificationId: persisted.qualification.id,
      shortCircuited: Boolean(reasoner.shortCircuited),
      reasonerCalls: budget.reasonerCalls,
      criticCalls: budget.criticCalls,
      nextJobId: persisted.criticJob?.id || null,
    };
  } catch (err) {
    return failStage(db, { job, prospect, now, err, stage: "qualify" });
  }
}

async function runCritic({ db, job, prospect, campaign, now, chatFn, detailedChatFn, timeoutMs, budget: sharedBudget }) {
  if (prospect.lifecycleState !== "qualifying" && prospect.lifecycleState !== "needs_review") {
    return failStage(db, {
      job,
      prospect,
      now,
      err: Object.assign(new Error("illegal_critic_lifecycle"), { code: GROWTH_ERROR_CODES.ILLEGAL_STATE }),
      stage: "critic",
    });
  }
  const qualification = await db.growthQualification.findFirst({
    where: { prospectId: prospect.id },
    orderBy: { createdAt: "desc" },
    include: { reasons: { include: { evidenceLinks: { include: { evidence: true } } } } },
  });
  if (!qualification) {
    return failStage(db, {
      job,
      prospect,
      now,
      err: Object.assign(new Error("missing_qualification"), { code: GROWTH_ERROR_CODES.CRITIC_FAILED }),
      stage: "critic",
    });
  }

  const existingReview = await db.growthCriticReview.findUnique({
    where: { qualificationId: qualification.id },
  });
  if (existingReview) {
    const lifecycle =
      existingReview.reviewState === "accepted"
        ? "qualified"
        : existingReview.reviewState === "rejected"
          ? "rejected"
          : "needs_review";
    await db.$transaction((tx) =>
      persistCriticSuccess(tx, {
        job,
        prospect,
        qualification,
        criticRow: existingReview,
        now,
        lifecycle,
        reviewState: existingReview.reviewState,
        decision: qualification.decision,
      })
    );
    return { status: "already_complete", claim: "claimed", stage: "critic", qualificationId: qualification.id };
  }

  const researchJob = await db.growthJob.findFirst({
    where: { prospectId: prospect.id, type: "research", status: "succeeded" },
    orderBy: { finishedAt: "desc" },
  });
  const runId = researchJob?.id;
  const runRows = runId
    ? await db.growthEvidence.findMany({ where: { prospectId: prospect.id, runId } })
    : [];
  const pack = reconstructPackFromEvidence(prospect, runRows);
  const inMemoryQual = qualificationToContract(qualification);
  const budget = sharedBudget || createGrowthAiBudget();
  const criticChat = wrapBudgetedChat({
    chatFn,
    detailedChatFn,
    timeoutMs: timeoutMs ?? GROWTH_AI_TIMEOUT_MS,
    budget,
    stage: "critic",
  });

  const critic = await reviewQualification({
    pack,
    productProfile: campaignToProfile(campaign),
    qualification: inMemoryQual,
    chatFn: criticChat,
    retryInvalidJson: false,
    transportAttempts: 1,
  });

  if (critic.technicalFailure || !critic.ok) {
    return failStage(db, {
      job,
      prospect,
      now,
      err: Object.assign(new Error(critic.error || "critic_technical_failure"), {
        code: classifyFailure({ message: critic.error, code: critic.error }, "critic").code,
      }),
      stage: "critic",
    });
  }

  let pipelineStatus = "accept";
  if (critic.verdict === "fail") pipelineStatus = "reject";
  else if (critic.verdict === "needs_review") pipelineStatus = "needs_review";

  const serialized = serializeQualificationForPersistence({
    status: pipelineStatus,
    qualification: inMemoryQual,
    critic,
    reasoner: { shortCircuited: qualification.shortCircuited, usage: {} },
    shortCircuited: qualification.shortCircuited,
  });
  const final = resolveLifecycleFromReview(serialized.reviewState, inMemoryQual, {
    shortCircuited: qualification.shortCircuited,
  });

  if (final.lifecycle === "qualified" && qualification.producedBy === "llm" && !hasGroundedReasons(inMemoryQual)) {
    final.lifecycle = "needs_review";
    final.reviewState = "needs_review";
  }

  await db.$transaction((tx) =>
    persistCriticSuccess(tx, {
      job,
      prospect,
      qualification,
      criticRow: {
        qualificationId: qualification.id,
        policyVerdict: critic.policy?.verdict || null,
        llmVerdict: critic.llmReview?.verdict || null,
        finalVerdict: critic.verdict,
        reviewState: final.reviewState,
        criticModel: critic.usage?.model || null,
        criticProvider: "aicredits",
        items: critic.items || null,
        criticPromptVersion: 1,
        promptTokens: budget.lastUsage?.prompt_tokens ?? null,
        completionTokens: budget.lastUsage?.completion_tokens ?? null,
        totalTokens: budget.lastUsage?.total_tokens ?? null,
      },
      now,
      lifecycle: final.lifecycle,
      reviewState: final.reviewState,
      decision: qualification.decision,
    })
  );

  return {
    status: "succeeded",
    claim: "claimed",
    stage: "critic",
    reviewState: final.reviewState,
    lifecycle: final.lifecycle,
    criticCalls: budget.criticCalls,
    accepted: final.reviewState === "accepted",
  };
}

async function failStage(db, { job, prospect, now, err, stage }) {
  const classified = classifyFailure(err, stage);
  const toLifecycle =
    classified.retryable && stage === "research"
      ? "research_pending"
      : classified.retryable && (stage === "qualify" || stage === "critic")
        ? (stage === "critic" ? "needs_review" : "qualification_pending")
        : stage === "critic"
          ? "needs_review"
          : "failed";
  await db.$transaction((tx) =>
    failJob(tx, {
      job: { ...job, status: "running" },
      prospect,
      fromLifecycle: prospect.lifecycleState,
      toLifecycle,
      code: classified.code,
      message: sanitizePersistedError(err?.message || err),
      now,
    })
  );
  return {
    status: "failed",
    claim: "claimed",
    errorCode: classified.code,
    retryable: classified.retryable,
    accepted: false,
  };
}

async function loadProspect(db, campaignId, prospectId) {
  const prospect = await db.growthProspect.findUnique({ where: { id: prospectId } });
  if (!prospect || prospect.campaignId !== campaignId) {
    const err = new Error("prospect_not_in_campaign");
    err.code = GROWTH_ERROR_CODES.ILLEGAL_STATE;
    throw err;
  }
  return prospect;
}

async function ensureResearchJob(db, prospect, now) {
  const existing = await db.growthJob.findFirst({
    where: { prospectId: prospect.id, type: "research" },
  });
  if (existing) return existing;
  if (!["candidate", "research_pending"].includes(prospect.lifecycleState)) return null;
  if (prospect.lifecycleState === "candidate") {
    await transitionProspect(db, prospect, "research_pending");
    prospect.lifecycleState = "research_pending";
  }
  return db.growthJob.create({
    data: {
      campaignId: prospect.campaignId,
      prospectId: prospect.id,
      type: "research",
      status: "pending",
      availableAt: now,
    },
  });
}

async function findClaimableJob(db, prospectId, now) {
  const jobs = await db.growthJob.findMany({ where: { prospectId } });
  const ready = jobs.filter((j) => {
    if (j.status === "pending") {
      const at = j.availableAt instanceof Date ? j.availableAt : new Date(j.availableAt);
      return at.getTime() <= now.getTime();
    }
    if (j.status === "running" && j.leaseExpiresAt) {
      const lease = j.leaseExpiresAt instanceof Date ? j.leaseExpiresAt : new Date(j.leaseExpiresAt);
      return lease.getTime() <= now.getTime();
    }
    return false;
  });
  ready.sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9));
  return ready[0] || null;
}

async function transitionProspect(db, prospect, to) {
  assertProspectTransition(prospect.lifecycleState, to);
  await db.growthProspect.update({
    where: { id: prospect.id },
    data: { lifecycleState: to },
  });
}

function campaignToProfile(campaign) {
  return {
    product: {
      name: campaign.productName,
      url: campaign.productUrl,
      description: campaign.productDescription,
    },
    goal: campaign.goal,
    targetPlatform: campaign.targetPlatform,
    desiredSignals: campaign.desiredSignals,
  };
}

function qualificationToContract(row) {
  const reasons = (row.reasons || []).map((r) => ({
    type: r.type,
    statement: r.statement,
    evidenceIds: (r.evidenceLinks || []).map((link) => link.evidence?.packEvidenceId).filter(Boolean),
  }));
  return {
    decision: row.decision,
    summary: row.summary,
    reasons,
    uncertainties: row.uncertainties || [],
    producedBy: row.producedBy,
  };
}

export function createGrowthAiBudget() {
  return {
    reasonerCalls: 0,
    criticCalls: 0,
    totalCalls: 0,
    lastUsage: null,
    lastModel: null,
  };
}

function createBudgetTracker() {
  return createGrowthAiBudget();
}

function wrapBudgetedChat({ chatFn, detailedChatFn, timeoutMs, budget, stage }) {
  return async (model, messages, opts = {}) => {
    const nextReasoner = budget.reasonerCalls + (stage === "reasoner" ? 1 : 0);
    const nextCritic = budget.criticCalls + (stage === "critic" ? 1 : 0);
    const nextTotal = budget.totalCalls + 1;
    if (
      nextReasoner > GROWTH_AI_BUDGET.maxReasonerCalls ||
      nextCritic > GROWTH_AI_BUDGET.maxCriticCalls ||
      nextTotal > GROWTH_AI_BUDGET.maxTotalCalls
    ) {
      const err = new Error("QUALIFICATION_BUDGET_EXCEEDED");
      err.code = GROWTH_ERROR_CODES.QUALIFICATION_BUDGET_EXCEEDED;
      throw err;
    }
    budget.reasonerCalls = nextReasoner;
    budget.criticCalls = nextCritic;
    budget.totalCalls = nextTotal;

    if (typeof detailedChatFn === "function") {
      const detailed = await detailedChatFn(model, messages, { ...opts, timeoutMs });
      budget.lastUsage = detailed?.usage || null;
      budget.lastModel = detailed?.model || model;
      return detailed?.content;
    }
    if (typeof chatFn === "function") {
      const result = await chatFn(model, messages, { ...opts, timeoutMs });
      if (result && typeof result === "object") {
        budget.lastUsage = result.usage || null;
        budget.lastModel = result.model || model;
        return result.content;
      }
      return result;
    }
    const detailed = await aicreditsChatDetailed(model, messages, { ...opts, timeoutMs });
    budget.lastUsage = detailed.usage;
    budget.lastModel = detailed.model;
    return detailed.content;
  };
}

function asDate(value) {
  if (value instanceof Date) return value;
  if (value) return new Date(value);
  return new Date();
}
