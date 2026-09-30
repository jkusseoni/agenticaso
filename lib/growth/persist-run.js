/**
 * Sanitized evidence persist + qualification/critic writes for one Growth run.
 * Never stores raw HTML or provider secret bodies.
 */

import { boundErrorMessage, GROWTH_PROVENANCE } from "./persistence.js";
import { hasGroundedReasons } from "./qualification-contract.js";
import { assertJobTransition, assertProspectTransition } from "./state-machine.js";

const HTML_RE = /<!DOCTYPE|<html[\s>]|<\/html>/i;
const SECRET_RE = /Bearer\s+[^\s]+|sk-[a-zA-Z0-9]+|aso_(?:live|test)_[a-zA-Z0-9]+|AICREDITS_API_KEY/gi;

export const GROWTH_ERROR_CODES = Object.freeze({
  RESEARCH_ROOT_FAILED: "RESEARCH_ROOT_FAILED",
  RESEARCH_ROOT_FORBIDDEN: "RESEARCH_ROOT_FORBIDDEN",
  RESEARCH_ROOT_NOT_FOUND: "RESEARCH_ROOT_NOT_FOUND",
  RESEARCH_TIMEOUT: "RESEARCH_TIMEOUT",
  RESEARCH_URL_REJECTED: "RESEARCH_URL_REJECTED",
  QUALIFICATION_TIMEOUT: "QUALIFICATION_TIMEOUT",
  QUALIFICATION_INVALID: "QUALIFICATION_INVALID",
  QUALIFICATION_BUDGET_EXCEEDED: "QUALIFICATION_BUDGET_EXCEEDED",
  CRITIC_TIMEOUT: "CRITIC_TIMEOUT",
  CRITIC_FAILED: "CRITIC_FAILED",
  PERSISTENCE_CONFLICT: "PERSISTENCE_CONFLICT",
  ILLEGAL_STATE: "ILLEGAL_STATE",
  SUPERSEDED_BY_RESEARCH_RERUN: "SUPERSEDED_BY_RESEARCH_RERUN",
});

export function sanitizePersistedError(text) {
  return boundErrorMessage(String(text || "").replace(SECRET_RE, "[redacted]"));
}

export function packToEvidenceRows(pack, { prospectId, jobId, runId }) {
  return (pack?.evidence || []).map((item) => ({
    prospectId,
    jobId,
    runId,
    packEvidenceId: String(item.id),
    claim: String(item.claim || "").slice(0, 280),
    sourceUrl: item.sourceUrl || null,
    sourceType: item.sourceType || null,
    observedData: item.observedData != null ? String(item.observedData).slice(0, 280) : null,
    confidence: typeof item.confidence === "number" ? item.confidence : null,
    verificationStatus: item.verificationStatus || null,
    extractor: item.extractor || null,
  }));
}

export function assertSanitizedEvidenceRows(rows) {
  const blob = JSON.stringify(rows);
  if (HTML_RE.test(blob)) {
    const err = new Error("evidence_contains_html");
    err.code = GROWTH_ERROR_CODES.PERSISTENCE_CONFLICT;
    throw err;
  }
  return rows;
}

/**
 * Rebuild a pack for qualification without raw HTML. EV ids are this run only.
 */
export function reconstructPackFromEvidence(prospect, rows, extras = {}) {
  const evidence = (rows || []).map((r) => ({
    id: r.packEvidenceId,
    claim: r.claim,
    sourceUrl: r.sourceUrl,
    sourceType: r.sourceType,
    observedData: r.observedData,
    confidence: r.confidence,
    verificationStatus: r.verificationStatus,
    extractor: r.extractor,
  }));
  return {
    version: extras.evidencePackVersion || GROWTH_PROVENANCE.evidencePackVersion,
    target: {
      requestedUrl: prospect.normalizedUrl,
      finalUrl: prospect.normalizedUrl,
      domain: prospect.canonicalDomain,
    },
    platform: {
      status: prospect.platformStatus || extras.platformStatus || "inconclusive",
      evidenceIds: evidence.map((e) => e.id),
    },
    signals: extras.signals || {},
    contacts: extras.contacts || [],
    evidence,
    collectionMeta: extras.collectionMeta || { warnings: extras.warnings || [], pagesCollected: extras.pagesCollected || 0 },
    notes: {
      contactsAreNotFitSignals: true,
      observedTextIsUntrusted: true,
      htmlOmitted: true,
    },
  };
}

export function mapCitationsToRun(packEvidenceIds, runRows) {
  const byId = new Map((runRows || []).map((r) => [r.packEvidenceId, r]));
  const missing = [];
  const mapped = [];
  for (const id of packEvidenceIds || []) {
    const row = byId.get(id);
    if (!row) missing.push(id);
    else mapped.push(row);
  }
  return { missing, mapped };
}

export function classifyFailure(err, stage) {
  const code = err?.code || "";
  const message = String(err?.message || err || "");
  const lower = message.toLowerCase();
  if (code === "AI_TIMEOUT" || err?.name === "AicreditsTimeoutError" || lower.includes("timed out") || lower.includes("timeout")) {
    if (stage === "research") return { code: GROWTH_ERROR_CODES.RESEARCH_TIMEOUT, retryable: true };
    if (stage === "critic") return { code: GROWTH_ERROR_CODES.CRITIC_TIMEOUT, retryable: true };
    return { code: GROWTH_ERROR_CODES.QUALIFICATION_TIMEOUT, retryable: true };
  }
  if (code === GROWTH_ERROR_CODES.QUALIFICATION_BUDGET_EXCEEDED || /budget/i.test(message)) {
    return { code: GROWTH_ERROR_CODES.QUALIFICATION_BUDGET_EXCEEDED, retryable: false };
  }
  if (code === GROWTH_ERROR_CODES.QUALIFICATION_INVALID || /invalid_model_output|unknown_evidence/i.test(message)) {
    return { code: GROWTH_ERROR_CODES.QUALIFICATION_INVALID, retryable: false };
  }
  if (/ssrf|private url|not a public|credentials_not_allowed|unsupported_protocol|blocked_path/i.test(lower)) {
    return { code: GROWTH_ERROR_CODES.RESEARCH_URL_REJECTED, retryable: false };
  }
  if (stage === "research") return { code: GROWTH_ERROR_CODES.RESEARCH_ROOT_FAILED, retryable: /econnreset|enotfound|temporar|503|429/.test(lower) };
  if (stage === "critic") return { code: GROWTH_ERROR_CODES.CRITIC_FAILED, retryable: /503|429|temporar/.test(lower) };
  return { code: GROWTH_ERROR_CODES.QUALIFICATION_INVALID, retryable: false };
}

export function classifyResearchCollectionFailure(collection) {
  const kind = collection?.failure?.kind;
  if (kind === "HTTP_FORBIDDEN") return { code: GROWTH_ERROR_CODES.RESEARCH_ROOT_FORBIDDEN, retryable: false };
  if (kind === "HTTP_NOT_FOUND") return { code: GROWTH_ERROR_CODES.RESEARCH_ROOT_NOT_FOUND, retryable: false };
  if (kind === "SSRF_REJECTED" || kind === "REDIRECT_REJECTED") {
    return { code: GROWTH_ERROR_CODES.RESEARCH_URL_REJECTED, retryable: false };
  }
  if (kind === "NETWORK_TIMEOUT") return { code: GROWTH_ERROR_CODES.RESEARCH_TIMEOUT, retryable: true };
  if (kind === "HTTP_RATE_LIMITED") return { code: GROWTH_ERROR_CODES.RESEARCH_ROOT_FAILED, retryable: true };
  return classifyFailure({ message: collection?.error || "" }, "research");
}

export async function failJob(tx, { job, prospect, fromLifecycle, toLifecycle, code, message, now }) {
  assertJobTransition(job.status === "running" ? "running" : job.status, "failed");
  const patch = {
    status: "failed",
    finishedAt: now,
    leaseExpiresAt: null,
    lastErrorCode: String(code || "FAILED").slice(0, 80),
    lastErrorMessage: sanitizePersistedError(message),
  };
  await tx.growthJob.update({ where: { id: job.id }, data: patch });
  if (prospect && fromLifecycle && toLifecycle && fromLifecycle !== toLifecycle) {
    assertProspectTransition(fromLifecycle, toLifecycle);
    await tx.growthProspect.update({
      where: { id: prospect.id },
      data: { lifecycleState: toLifecycle },
    });
  }
}

export async function persistResearchSuccess(tx, input) {
  const { job, prospect, pack, now } = input;
  const runId = job.id;
  const rows = assertSanitizedEvidenceRows(packToEvidenceRows(pack, {
    prospectId: prospect.id,
    jobId: job.id,
    runId,
  }));
  const existing = await tx.growthEvidence.findMany({
    where: { prospectId: prospect.id, runId },
  });
  const have = new Set(existing.map((e) => e.packEvidenceId));
  for (const row of rows) {
    if (have.has(row.packEvidenceId)) continue;
    await tx.growthEvidence.create({ data: row });
    have.add(row.packEvidenceId);
  }

  assertJobTransition("running", "succeeded");
  await tx.growthJob.update({
    where: { id: job.id },
    data: {
      status: "succeeded",
      finishedAt: now,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });

  let lifecycleState = prospect.lifecycleState;
  if (lifecycleState === "researching") {
    assertProspectTransition("researching", "researched");
    lifecycleState = "researched";
  }
  if (lifecycleState === "researched") {
    assertProspectTransition("researched", "qualification_pending");
    lifecycleState = "qualification_pending";
  }

  await tx.growthProspect.update({
    where: { id: prospect.id },
    data: {
      lifecycleState,
      platformStatus: pack.platform?.status || prospect.platformStatus || null,
    },
  });

  const existingQualify = await tx.growthJob.findFirst({
    where: { prospectId: prospect.id, type: "qualify", status: { in: ["pending", "running"] } },
    orderBy: { createdAt: "asc" },
  });
  let qualifyJob = existingQualify;
  if (!qualifyJob) {
    qualifyJob = await tx.growthJob.create({
      data: {
        campaignId: job.campaignId,
        prospectId: prospect.id,
        type: "qualify",
        status: "pending",
        availableAt: now,
      },
    });
  }
  return { runId, evidenceCount: have.size, qualifyJob, lifecycleState };
}

export function resolveLifecycleFromReview(reviewState, qualification, { shortCircuited } = {}) {
  if (shortCircuited) return { lifecycle: "rejected", reviewState: "rejected" };
  if (reviewState === "accepted") {
    if (!hasGroundedReasons(qualification) && qualification?.producedBy !== "deterministic") {
      return { lifecycle: "needs_review", reviewState: "needs_review" };
    }
    return { lifecycle: "qualified", reviewState: "accepted" };
  }
  if (reviewState === "rejected") return { lifecycle: "rejected", reviewState: "rejected" };
  return { lifecycle: "needs_review", reviewState: "needs_review" };
}

export async function persistQualificationAndMaybeCriticJob(tx, input) {
  const { job, prospect, serialized, runRows, now, needsCritic } = input;
  const existing = job.id
    ? await tx.growthQualification.findFirst({ where: { jobId: job.id } })
    : null;
  if (existing) {
    return recoverQualifySuccess(tx, { job, prospect, existing, now, needsCritic });
  }

  const unknown = [];
  for (const reason of serialized.reasons) {
    const mapped = mapCitationsToRun(reason.packEvidenceIds, runRows);
    if (mapped.missing.length) unknown.push(...mapped.missing);
  }
  if (unknown.length) {
    const err = new Error(`unknown_evidence:${unknown.join(",")}`);
    err.code = GROWTH_ERROR_CODES.QUALIFICATION_INVALID;
    throw err;
  }

  const qualification = await tx.growthQualification.create({
    data: {
      prospectId: prospect.id,
      jobId: job.id,
      decision: serialized.qualification.decision,
      summary: serialized.qualification.summary,
      producedBy: serialized.qualification.producedBy,
      shortCircuited: serialized.qualification.shortCircuited,
      structuralOk: serialized.qualification.structuralOk,
      reasonerModel: serialized.qualification.reasonerModel,
      reasonerProvider: serialized.qualification.reasonerProvider,
      uncertainties: serialized.qualification.uncertainties,
      evidencePackVersion: serialized.qualification.evidencePackVersion,
      qualificationContractVersion: serialized.qualification.qualificationContractVersion,
      reasonerPromptVersion: serialized.qualification.reasonerPromptVersion,
      schemaVersion: serialized.qualification.schemaVersion,
      reasonerCallCount: serialized.qualification.reasonerCallCount,
      promptTokens: serialized.qualification.promptTokens,
      completionTokens: serialized.qualification.completionTokens,
      totalTokens: serialized.qualification.totalTokens,
    },
  });

  for (const reason of serialized.reasons) {
    const created = await tx.growthQualificationReason.create({
      data: {
        qualificationId: qualification.id,
        type: reason.type,
        statement: String(reason.statement || "").slice(0, 400),
        sortOrder: reason.sortOrder,
      },
    });
    const mapped = mapCitationsToRun(reason.packEvidenceIds, runRows);
    for (const ev of mapped.mapped) {
      await tx.growthQualificationReasonEvidence.create({
        data: { reasonId: created.id, evidenceId: ev.id },
      });
    }
  }

  assertJobTransition("running", "succeeded");
  await tx.growthJob.update({
    where: { id: job.id },
    data: {
      status: "succeeded",
      finishedAt: now,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });

  const prospectData = {
    latestQualificationDecision: serialized.qualification.decision,
  };

  let criticJob = null;
  if (needsCritic) {
    criticJob = await tx.growthJob.findFirst({
      where: { prospectId: prospect.id, type: "critic" },
    });
    if (!criticJob) {
      criticJob = await tx.growthJob.create({
        data: {
          campaignId: job.campaignId,
          prospectId: prospect.id,
          type: "critic",
          status: "pending",
          availableAt: now,
        },
      });
    }
  } else {
    const final = resolveLifecycleFromReview(serialized.reviewState, {
      ...serialized.qualification,
      reasons: serialized.reasons.map((r) => ({ evidenceIds: r.packEvidenceIds })),
      producedBy: serialized.qualification.producedBy,
    }, { shortCircuited: serialized.qualification.shortCircuited });
    assertProspectTransition(prospect.lifecycleState, final.lifecycle);
    prospectData.lifecycleState = final.lifecycle;
    prospectData.latestReviewState = final.reviewState;
  }

  await tx.growthProspect.update({
    where: { id: prospect.id },
    data: prospectData,
  });

  return { qualification, criticJob };
}

async function recoverQualifySuccess(tx, { job, prospect, existing, now, needsCritic }) {
  if (job.status === "running") {
    await tx.growthJob.update({
      where: { id: job.id },
      data: { status: "succeeded", finishedAt: now, leaseExpiresAt: null },
    });
  }
  let criticJob = null;
  if (needsCritic) {
    criticJob = await tx.growthJob.findFirst({
      where: { prospectId: prospect.id, type: "critic" },
    });
    if (!criticJob) {
      criticJob = await tx.growthJob.create({
        data: {
          campaignId: job.campaignId,
          prospectId: prospect.id,
          type: "critic",
          status: "pending",
          availableAt: now,
        },
      });
    }
  }
  return { qualification: existing, criticJob, recovered: true };
}

export async function persistCriticSuccess(tx, input) {
  const { job, prospect, qualification, criticRow, now, lifecycle, reviewState, decision } = input;
  const existing = await tx.growthCriticReview.findUnique({
    where: { qualificationId: qualification.id },
  });
  if (!existing) {
    await tx.growthCriticReview.create({
      data: {
        qualificationId: criticRow.qualificationId,
        policyVerdict: criticRow.policyVerdict ?? null,
        llmVerdict: criticRow.llmVerdict ?? null,
        finalVerdict: criticRow.finalVerdict,
        reviewState: criticRow.reviewState,
        criticModel: criticRow.criticModel ?? null,
        criticProvider: criticRow.criticProvider ?? null,
        items: criticRow.items ?? null,
        criticPromptVersion: criticRow.criticPromptVersion ?? 1,
        promptTokens: criticRow.promptTokens ?? null,
        completionTokens: criticRow.completionTokens ?? null,
        totalTokens: criticRow.totalTokens ?? null,
      },
    });
  }
  if (job.status === "running") {
    assertJobTransition("running", "succeeded");
    await tx.growthJob.update({
      where: { id: job.id },
      data: {
        status: "succeeded",
        finishedAt: now,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
  }
  const prospectData = {
    latestReviewState: reviewState,
    ...(decision ? { latestQualificationDecision: decision } : {}),
  };
  if (lifecycle && prospect.lifecycleState !== lifecycle) {
    assertProspectTransition(prospect.lifecycleState, lifecycle);
    prospectData.lifecycleState = lifecycle;
  }
  await tx.growthProspect.update({
    where: { id: prospect.id },
    data: prospectData,
  });
}
