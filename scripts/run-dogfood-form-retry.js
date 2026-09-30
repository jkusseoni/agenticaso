/**
 * Phase 4A.3.2 — one Form Nutrition research retry on staging.
 * Does not revive the historical failed job. Does not run qualification.
 */
import { PrismaClient } from "@prisma/client";
import { assertStagingTarget, loadDogfoodEnv, SYNTHETIC_DOGFOOD_CLERK_USER_ID } from "../lib/growth/dogfood-env.js";
import { processGrowthJob } from "../lib/growth/orchestrator.js";
import { defaultResearchFetch } from "../lib/growth/research-collector.js";
import { classifyRootFetchFailure } from "../lib/growth/root-reachability.js";
import { enqueueFailedResearchRetry } from "../lib/growth/research-retry.js";
import { SIGNAL_KEYS } from "../lib/growth/commerce-signals.js";

const EXPECTED = Object.freeze({
  workspaceId: "cmu8b10rq0000o0dc3pzc7pda",
  campaignId: "cmu8cv6zk0001o048nzo7ba6x",
  formProspectId: "cmu8cv7530003o048p9btabcy",
  oldJobId: "cmu8cv7gg0005o048imw3oxcu",
  coraProspectId: "cmu8cv7lo0007o0487pn08lkb",
  workbenchProspectId: "cmu8cv7u5000bo048dqyku19u",
});

const HTML_RE = /<!DOCTYPE|<html[\s>]|<\/html>/i;
const OTHER_DOMAINS = ["coraandspink.com", "theworkbenchlondon.com"];

function forbiddenAi(bucket, name) {
  return async () => {
    bucket[name] += 1;
    bucket.total += 1;
    throw new Error(`AI_HARD_BLOCK: unexpected ${name} call`);
  };
}

function containsHtml(value) {
  if (value == null) return false;
  if (typeof value === "string") return HTML_RE.test(value);
  try {
    return HTML_RE.test(JSON.stringify(value));
  } catch {
    return false;
  }
}

async function main() {
  const loaded = loadDogfoodEnv();
  const identity = assertStagingTarget(loaded);
  const aiCalls = { reasoner: 0, critic: 0, detailed: 0, chat: 0, total: 0 };
  const fetchLog = [];

  if (!identity.ok || identity.classified.classification !== "staging") {
    console.log(JSON.stringify({ ok: false, token: "FORM_RESEARCH_FAIL", reason: "staging_identity" }, null, 2));
    process.exit(2);
  }
  if (loaded.GROWTH_DOGFOOD_WORKSPACE_ID !== EXPECTED.workspaceId) {
    console.log(JSON.stringify({ ok: false, token: "FORM_RESEARCH_FAIL", reason: "workspace_mismatch" }, null, 2));
    process.exit(2);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: loaded.GROWTH_DOGFOOD_DATABASE_URL } } });
  try {
    const workspace = await prisma.workspace.findUnique({ where: { id: EXPECTED.workspaceId } });
    const campaign = await prisma.growthCampaign.findUnique({ where: { id: EXPECTED.campaignId } });
    if (!workspace || workspace.clerkUserId !== SYNTHETIC_DOGFOOD_CLERK_USER_ID || !campaign || campaign.workspaceId !== EXPECTED.workspaceId) {
      console.log(JSON.stringify({ ok: false, token: "FORM_RESEARCH_FAIL", reason: "identity_mismatch" }, null, 2));
      process.exit(2);
    }

    const form = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.formProspectId } });
    const oldJob = await prisma.growthJob.findUnique({ where: { id: EXPECTED.oldJobId } });
    const cora = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.coraProspectId } });
    const wb = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.workbenchProspectId } });
    const issues = [];
    if (form?.canonicalDomain !== "formnutrition.com" || form?.lifecycleState !== "failed") issues.push("form_pre_state");
    if (oldJob?.status !== "failed" || oldJob?.prospectId !== EXPECTED.formProspectId) issues.push("old_job");
    if (cora?.canonicalDomain !== "coraandspink.com" || cora?.lifecycleState !== "research_pending") issues.push("cora");
    if (wb?.canonicalDomain !== "theworkbenchlondon.com" || wb?.lifecycleState !== "research_pending") issues.push("workbench");
    const preEvidence = await prisma.growthEvidence.count();
    const preQual = await prisma.growthQualification.count();
    const preCritic = await prisma.growthCriticReview.count();
    if (preEvidence || preQual || preCritic) issues.push("pre_rows");
    if (issues.length) {
      console.log(JSON.stringify({ ok: false, token: "FORM_RESEARCH_FAIL", issues, pre: { form: form?.lifecycleState, oldJob: oldJob?.status, oldError: oldJob?.lastErrorCode } }, null, 2));
      process.exit(2);
    }

    const enqueueOnce = await enqueueFailedResearchRetry(prisma, { prospectId: EXPECTED.formProspectId });
    const enqueueTwice = await enqueueFailedResearchRetry(prisma, { prospectId: EXPECTED.formProspectId });
    if (!enqueueOnce.ok || enqueueOnce.job.id === EXPECTED.oldJobId) {
      console.log(JSON.stringify({ ok: false, token: "FORM_RESEARCH_FAIL", reason: "retry_enqueue", enqueueOnce }, null, 2));
      process.exit(2);
    }
    if (!enqueueTwice.ok || !enqueueTwice.reused || enqueueTwice.job.id !== enqueueOnce.job.id) {
      console.log(JSON.stringify({ ok: false, token: "FORM_RESEARCH_FAIL", reason: "retry_not_idempotent", enqueueTwice }, null, 2));
      process.exit(2);
    }

    const oldAfterEnqueue = await prisma.growthJob.findUnique({ where: { id: EXPECTED.oldJobId } });
    if (oldAfterEnqueue.status !== "failed" || oldAfterEnqueue.lastErrorCode !== oldJob.lastErrorCode) {
      console.log(JSON.stringify({ ok: false, token: "FORM_RESEARCH_FAIL", reason: "old_job_mutated" }, null, 2));
      process.exit(2);
    }

    const fetchFn = async (url, opts) => {
      const host = (() => {
        try {
          return new URL(url).hostname.replace(/^www\./, "");
        } catch {
          return "";
        }
      })();
      if (OTHER_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
        throw new Error(`DOMAIN_BOUNDARY: refused fetch to ${host}`);
      }
      const res = await defaultResearchFetch(url, opts);
      const classified = classifyRootFetchFailure({
        status: res?.status,
        error: res?.ok === false ? `HTTP ${res.status}` : "",
        headers: res?.headers,
        body: typeof res?.text === "string" ? res.text : "",
      });
      fetchLog.push({
        attempt: fetchLog.length + 1,
        requestedUrl: url,
        finalUrl: res?.finalUrl || null,
        ok: res?.ok !== false,
        status: res?.status ?? null,
        kind: res?.ok === false ? classified.kind : "HTTP_OK",
        bytes: Buffer.byteLength(String(res?.text || ""), "utf8"),
        redirected: Boolean(res?.finalUrl && res.finalUrl !== url),
      });
      return res;
    };

    const outcome = await processGrowthJob({
      db: prisma,
      jobId: enqueueOnce.job.id,
      fetchFn,
      chatFn: forbiddenAi(aiCalls, "chat"),
      detailedChatFn: forbiddenAi(aiCalls, "detailed"),
    });

    const newJob = await prisma.growthJob.findUnique({ where: { id: enqueueOnce.job.id } });
    const oldJobFinal = await prisma.growthJob.findUnique({ where: { id: EXPECTED.oldJobId } });
    const formFinal = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.formProspectId } });
    const coraFinal = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.coraProspectId } });
    const wbFinal = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.workbenchProspectId } });
    const formJobs = await prisma.growthJob.findMany({ where: { prospectId: EXPECTED.formProspectId } });
    const qualifyJobs = formJobs.filter((j) => j.type === "qualify");
    const evidence = await prisma.growthEvidence.findMany({ where: { prospectId: EXPECTED.formProspectId } });
    const otherEvidence = await prisma.growthEvidence.count({
      where: { prospectId: { in: [EXPECTED.coraProspectId, EXPECTED.workbenchProspectId] } },
    });
    const qualifications = await prisma.growthQualification.count();
    const critic = await prisma.growthCriticReview.count();
    const coraJobs = await prisma.growthJob.findMany({ where: { prospectId: EXPECTED.coraProspectId } });
    const wbJobs = await prisma.growthJob.findMany({ where: { prospectId: EXPECTED.workbenchProspectId } });

    const htmlHits = evidence.filter((e) => containsHtml(e.claim) || containsHtml(e.observedData)).length
      + (containsHtml(newJob?.lastErrorMessage) ? 1 : 0);
    const successfulRoots = fetchLog.filter((f) => f.ok && new URL(f.requestedUrl).pathname === "/");
    const effectiveRoot = successfulRoots.length ? successfulRoots[successfulRoots.length - 1].finalUrl : null;
    if (effectiveRoot) {
      const row = fetchLog.find((f) => f.finalUrl === effectiveRoot || f.requestedUrl === effectiveRoot);
      if (row) row.becameEffectiveRoot = true;
    }

    const packSignals = {};
    for (const key of SIGNAL_KEYS) packSignals[key] = { key, evidenceIds: [] };
    for (const row of evidence) {
      for (const key of SIGNAL_KEYS) {
        if (String(row.claim || "").toLowerCase().includes(key.replace("_", " ")) || String(row.extractor || "").includes(key)) {
          packSignals[key].evidenceIds.push(row.packEvidenceId);
        }
      }
    }

    console.log(
      JSON.stringify(
        {
          staging: {
            host: identity.staging.redactedHost,
            database: identity.staging.database,
            classification: identity.classified.classification,
          },
          collision: false,
          oldJob: {
            id: oldJobFinal.id,
            status: oldJobFinal.status,
            lastErrorCode: oldJobFinal.lastErrorCode,
            lastErrorMessage: oldJobFinal.lastErrorMessage,
            attempts: oldJobFinal.attempts,
          },
          retry: {
            transition: "failed→research_pending via reopen_failed_research",
            newJobId: enqueueOnce.job.id,
            created: enqueueOnce.created,
            secondEnqueueReused: enqueueTwice.reused,
          },
          outcome: {
            status: outcome.status,
            errorCode: outcome.errorCode || null,
            evidenceCount: outcome.evidenceCount ?? null,
            nextJobId: outcome.nextJobId || null,
            warnings: outcome.warnings || [],
            rootAttempts: outcome.rootAttempts ?? null,
            variantAttempted: outcome.variantAttempted ?? null,
          },
          fetchLog,
          effectiveRoot,
          form: {
            lifecycleState: formFinal.lifecycleState,
            platformStatus: formFinal.platformStatus,
            newJob: {
              id: newJob.id,
              status: newJob.status,
              lastErrorCode: newJob.lastErrorCode,
              lastErrorMessage: newJob.lastErrorMessage,
              attempts: newJob.attempts,
            },
            qualifyJobs: qualifyJobs.map((j) => ({ id: j.id, status: j.status })),
            evidence: evidence.map((e) => ({
              id: e.id,
              packEvidenceId: e.packEvidenceId,
              runId: e.runId,
              jobId: e.jobId,
              claim: e.claim,
              observedData: e.observedData,
              sourceUrl: e.sourceUrl,
              sourceType: e.sourceType,
              extractor: e.extractor,
              confidence: e.confidence,
              verificationStatus: e.verificationStatus,
            })),
          },
          others: {
            cora: { lifecycle: coraFinal.lifecycleState, jobs: coraJobs.map((j) => ({ id: j.id, type: j.type, status: j.status })) },
            workbench: { lifecycle: wbFinal.lifecycleState, jobs: wbJobs.map((j) => ({ id: j.id, type: j.type, status: j.status })) },
            otherEvidence,
          },
          counts: {
            qualifications,
            critic,
            htmlHits,
            aiCalls,
            evidenceOnOldRun: evidence.filter((e) => e.runId === EXPECTED.oldJobId).length,
            evidenceOnNewRun: evidence.filter((e) => e.runId === newJob.id).length,
          },
        },
        null,
        2
      )
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, token: "FORM_RESEARCH_FAIL", error: String(err?.message || err).slice(0, 400) }, null, 2));
  process.exit(1);
});
