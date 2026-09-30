/**
 * Phase 4A.4.2 — fresh Cora research after evidence-quality hardening.
 * Cancels the stale qualify job, enqueues one research refresh, runs that job only.
 * Does not execute qualification. AI chat throws if called.
 */
import { PrismaClient } from "@prisma/client";
import { assertStagingTarget, loadDogfoodEnv, SYNTHETIC_DOGFOOD_CLERK_USER_ID } from "../lib/growth/dogfood-env.js";
import { processGrowthJob } from "../lib/growth/orchestrator.js";
import { defaultResearchFetch } from "../lib/growth/research-collector.js";
import { classifyRootFetchFailure } from "../lib/growth/root-reachability.js";
import { enqueueGrowthResearchRefresh, RESEARCH_REFRESH_REASON } from "../lib/growth/research-refresh.js";
import { SIGNAL_KEYS } from "../lib/growth/commerce-signals.js";
import { reconstructPackFromEvidence } from "../lib/growth/persist-run.js";

const EXPECTED = Object.freeze({
  workspaceId: "cmu8b10rq0000o0dc3pzc7pda",
  campaignId: "cmu8cv6zk0001o048nzo7ba6x",
  coraProspectId: "cmu8cv7lo0007o0487pn08lkb",
  historicalResearchJobId: "cmu8cv7ra0009o048d3e2o32s",
  historicalQualifyJobId: "cmu8ebml4000zo0io034ebd9e",
  formProspectId: "cmu8cv7530003o048p9btabcy",
  workbenchProspectId: "cmu8cv7u5000bo048dqyku19u",
  workbenchJobId: "cmu8cv7zv000do048hf9eimqz",
});

const HTML_RE = /<!DOCTYPE|<html[\s>]|<\/html>/i;
const BLOCKED_REGISTRABLE = ["formnutrition.com", "theworkbenchlondon.com"];

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

function registrable(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function jobView(j) {
  if (!j) return null;
  return {
    id: j.id,
    type: j.type,
    status: j.status,
    lastErrorCode: j.lastErrorCode || null,
    lastErrorMessage: j.lastErrorMessage || null,
    attempts: j.attempts,
  };
}

async function main() {
  const loaded = loadDogfoodEnv();
  const identity = assertStagingTarget(loaded);
  const aiCalls = { reasoner: 0, critic: 0, detailed: 0, chat: 0, total: 0 };
  const fetchLog = [];

  if (!identity.ok || identity.classified.classification !== "staging") {
    console.log(JSON.stringify({ ok: false, token: "CORA_FRESH_EVIDENCE_FAIL", reason: "staging_identity" }, null, 2));
    process.exit(2);
  }
  if (loaded.GROWTH_DOGFOOD_WORKSPACE_ID && loaded.GROWTH_DOGFOOD_WORKSPACE_ID !== EXPECTED.workspaceId) {
    console.log(JSON.stringify({ ok: false, token: "CORA_FRESH_EVIDENCE_FAIL", reason: "workspace_mismatch" }, null, 2));
    process.exit(2);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: loaded.GROWTH_DOGFOOD_DATABASE_URL } } });
  try {
    const workspace = await prisma.workspace.findUnique({ where: { id: EXPECTED.workspaceId } });
    const campaign = await prisma.growthCampaign.findUnique({ where: { id: EXPECTED.campaignId } });
    const cora = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.coraProspectId } });
    const historicalResearch = await prisma.growthJob.findUnique({ where: { id: EXPECTED.historicalResearchJobId } });
    const historicalQualify = await prisma.growthJob.findUnique({ where: { id: EXPECTED.historicalQualifyJobId } });
    const form = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.formProspectId } });
    const wb = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.workbenchProspectId } });
    const wbJob = await prisma.growthJob.findUnique({ where: { id: EXPECTED.workbenchJobId } });
    const historicalEvidence = await prisma.growthEvidence.findMany({
      where: { prospectId: EXPECTED.coraProspectId, runId: EXPECTED.historicalResearchJobId },
      orderBy: { packEvidenceId: "asc" },
    });
    const qualCount = await prisma.growthQualification.count();
    const criticCount = await prisma.growthCriticReview.count();

    const pre = {
      staging: {
        env: loaded.GROWTH_DOGFOOD_ENV,
        host: identity.staging.redactedHost,
        database: identity.staging.database,
        classification: identity.classified.classification,
      },
      production: { host: identity.production.redactedHost, database: identity.production.database },
      workspaceOk: workspace?.clerkUserId === SYNTHETIC_DOGFOOD_CLERK_USER_ID,
      cora: { id: cora?.id, domain: cora?.canonicalDomain, lifecycle: cora?.lifecycleState, platformStatus: cora?.platformStatus },
      historicalResearch: jobView(historicalResearch),
      historicalQualify: jobView(historicalQualify),
      historicalEvidenceCount: historicalEvidence.length,
      form: { id: form?.id, lifecycle: form?.lifecycleState },
      workbench: { id: wb?.id, lifecycle: wb?.lifecycleState, jobStatus: wbJob?.status },
      qualCount,
      criticCount,
    };

    const issues = [];
    if (!workspace || workspace.clerkUserId !== SYNTHETIC_DOGFOOD_CLERK_USER_ID) issues.push("workspace");
    if (!campaign || campaign.workspaceId !== EXPECTED.workspaceId) issues.push("campaign");
    if (cora?.canonicalDomain !== "coraandspink.com") issues.push("cora_identity");
    if (cora?.lifecycleState !== "qualification_pending") issues.push("cora_lifecycle");
    if (historicalResearch?.status !== "succeeded" || historicalResearch?.type !== "research") issues.push("historical_research");
    if (historicalQualify?.status !== "pending" || historicalQualify?.type !== "qualify") issues.push("historical_qualify");
    if (historicalEvidence.length !== 17) issues.push("historical_evidence_count");
    if (qualCount !== 0 || criticCount !== 0) issues.push("pre_qual_critic");
    if (wb?.lifecycleState !== "research_pending" || wbJob?.status !== "pending") issues.push("workbench_pre");
    if (form?.lifecycleState !== "failed") issues.push("form_pre");
    if (issues.length) {
      console.log(JSON.stringify({ ok: false, token: "CORA_FRESH_EVIDENCE_FAIL", reason: "preflight", issues, pre }, null, 2));
      process.exit(2);
    }

    const refresh1 = await enqueueGrowthResearchRefresh(prisma, { prospectId: EXPECTED.coraProspectId });
    const refresh2 = await enqueueGrowthResearchRefresh(prisma, { prospectId: EXPECTED.coraProspectId });
    if (!refresh1.ok || !refresh1.created || refresh1.reused) {
      console.log(JSON.stringify({ ok: false, token: "CORA_FRESH_EVIDENCE_FAIL", reason: "refresh_enqueue", refresh1 }, null, 2));
      process.exit(2);
    }
    if (!refresh2.ok || !refresh2.reused || refresh2.job.id !== refresh1.job.id) {
      console.log(JSON.stringify({ ok: false, token: "CORA_FRESH_EVIDENCE_FAIL", reason: "refresh_idempotency", refresh1, refresh2 }, null, 2));
      process.exit(2);
    }

    const freshJobId = refresh1.job.id;
    const qualifyAfterRefresh = await prisma.growthJob.findUnique({ where: { id: EXPECTED.historicalQualifyJobId } });
    const coraAfterRefresh = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.coraProspectId } });
    const historicalEvidenceAfterRefresh = await prisma.growthEvidence.count({
      where: { prospectId: EXPECTED.coraProspectId, runId: EXPECTED.historicalResearchJobId },
    });

    const fetchFn = async (url, opts) => {
      const host = registrable(url);
      if (BLOCKED_REGISTRABLE.includes(host)) {
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
        pathname: (() => {
          try {
            return new URL(url).pathname;
          } catch {
            return null;
          }
        })(),
      });
      return res;
    };

    const outcome = await processGrowthJob({
      db: prisma,
      jobId: freshJobId,
      fetchFn,
      chatFn: forbiddenAi(aiCalls, "chat"),
      detailedChatFn: forbiddenAi(aiCalls, "detailed"),
    });

    const jobFinal = await prisma.growthJob.findUnique({ where: { id: freshJobId } });
    const historicalResearchFinal = await prisma.growthJob.findUnique({ where: { id: EXPECTED.historicalResearchJobId } });
    const historicalQualifyFinal = await prisma.growthJob.findUnique({ where: { id: EXPECTED.historicalQualifyJobId } });
    const coraFinal = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.coraProspectId } });
    const formFinal = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.formProspectId } });
    const wbFinal = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.workbenchProspectId } });
    const wbJobFinal = await prisma.growthJob.findUnique({ where: { id: EXPECTED.workbenchJobId } });
    const formJobs = await prisma.growthJob.findMany({
      where: { prospectId: EXPECTED.formProspectId },
      select: { id: true, type: true, status: true, lastErrorCode: true },
    });
    const coraJobs = await prisma.growthJob.findMany({
      where: { prospectId: EXPECTED.coraProspectId },
      orderBy: { createdAt: "asc" },
    });
    const historicalEvidenceFinal = await prisma.growthEvidence.findMany({
      where: { prospectId: EXPECTED.coraProspectId, runId: EXPECTED.historicalResearchJobId },
      orderBy: { packEvidenceId: "asc" },
    });
    const freshEvidence = await prisma.growthEvidence.findMany({
      where: { prospectId: EXPECTED.coraProspectId, runId: freshJobId },
      orderBy: { packEvidenceId: "asc" },
    });
    const otherEvidence = await prisma.growthEvidence.count({
      where: { prospectId: { in: [EXPECTED.formProspectId, EXPECTED.workbenchProspectId] } },
    });
    const qualifications = await prisma.growthQualification.count();
    const critic = await prisma.growthCriticReview.count();
    const qualifyJobs = coraJobs.filter((j) => j.type === "qualify");
    const runnableQualify = qualifyJobs.filter((j) => j.status === "pending" || j.status === "running");
    const pack = reconstructPackFromEvidence(coraFinal, freshEvidence, { platformStatus: coraFinal.platformStatus });

    const htmlHits = [
      ...freshEvidence.flatMap((e) => ["claim", "observedData", "sourceUrl", "extractor"].filter((f) => containsHtml(e[f]))),
      ...(containsHtml(jobFinal?.lastErrorMessage) ? ["job_error"] : []),
      ...(containsHtml(coraFinal) ? ["prospect"] : []),
    ];

    const rootFetches = fetchLog.filter((f) => f.pathname === "/" || f.pathname === "");
    const successfulRoots = rootFetches.filter((f) => f.ok);
    const effectiveRoot = successfulRoots.length ? successfulRoots[successfulRoots.length - 1].finalUrl : null;
    const secondary = fetchLog.filter((f) => f.pathname && f.pathname !== "/");

    console.log(
      JSON.stringify(
        {
          pre,
          refresh: {
            reason: RESEARCH_REFRESH_REASON,
            first: {
              ok: refresh1.ok,
              created: refresh1.created,
              reused: refresh1.reused,
              jobId: refresh1.job.id,
              cancelledQualifyJobIds: refresh1.cancelledQualifyJobIds,
              lifecycle: refresh1.prospect.lifecycleState,
            },
            second: {
              ok: refresh2.ok,
              created: refresh2.created,
              reused: refresh2.reused,
              jobId: refresh2.job.id,
              cancelledQualifyJobIds: refresh2.cancelledQualifyJobIds,
            },
            afterEnqueue: {
              lifecycle: coraAfterRefresh.lifecycleState,
              historicalQualify: jobView(qualifyAfterRefresh),
              historicalEvidenceCount: historicalEvidenceAfterRefresh,
            },
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
          rootFetches,
          effectiveRoot,
          secondaryUrls: secondary.map((f) => f.requestedUrl),
          cora: {
            lifecycleState: coraFinal.lifecycleState,
            platformStatus: coraFinal.platformStatus,
            historicalResearch: jobView(historicalResearchFinal),
            historicalQualify: jobView(historicalQualifyFinal),
            freshResearch: jobView(jobFinal),
            qualifyJobs: qualifyJobs.map(jobView),
            runnableQualifyCount: runnableQualify.length,
            historicalEvidenceCount: historicalEvidenceFinal.length,
            historicalEvidenceRunIds: [...new Set(historicalEvidenceFinal.map((e) => e.runId))],
            freshEvidence: freshEvidence.map((e) => ({
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
          pack: {
            platform: pack.platform,
            signals: pack.signals,
            contacts: pack.contacts,
          },
          signalKeys: SIGNAL_KEYS,
          others: {
            form: { lifecycle: formFinal.lifecycleState, jobs: formJobs },
            workbench: {
              lifecycle: wbFinal.lifecycleState,
              job: { id: wbJobFinal.id, status: wbJobFinal.status, type: wbJobFinal.type },
            },
            otherEvidence,
          },
          counts: { qualifications, critic, htmlHits: htmlHits.length, aiCalls },
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
  console.error(JSON.stringify({ ok: false, token: "CORA_FRESH_EVIDENCE_FAIL", error: String(err?.message || err).slice(0, 400) }, null, 2));
  process.exit(1);
});
