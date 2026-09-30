/**
 * Phase 4A — one Cora + Spink research job on staging.
 * Does not run qualification. AI chat throws if called.
 */
import { PrismaClient } from "@prisma/client";
import { assertStagingTarget, loadDogfoodEnv, SYNTHETIC_DOGFOOD_CLERK_USER_ID } from "../lib/growth/dogfood-env.js";
import { processGrowthJob } from "../lib/growth/orchestrator.js";
import { defaultResearchFetch } from "../lib/growth/research-collector.js";
import { classifyRootFetchFailure } from "../lib/growth/root-reachability.js";
import { SIGNAL_KEYS } from "../lib/growth/commerce-signals.js";

const EXPECTED = Object.freeze({
  workspaceId: "cmu8b10rq0000o0dc3pzc7pda",
  campaignId: "cmu8cv6zk0001o048nzo7ba6x",
  coraProspectId: "cmu8cv7lo0007o0487pn08lkb",
  coraJobId: "cmu8cv7ra0009o048d3e2o32s",
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

async function main() {
  const loaded = loadDogfoodEnv();
  const identity = assertStagingTarget(loaded);
  const aiCalls = { reasoner: 0, critic: 0, detailed: 0, chat: 0, total: 0 };
  const fetchLog = [];

  if (!identity.ok || identity.classified.classification !== "staging") {
    console.log(JSON.stringify({ ok: false, token: "CORA_RESEARCH_FAIL", reason: "staging_identity" }, null, 2));
    process.exit(2);
  }
  if (loaded.GROWTH_DOGFOOD_WORKSPACE_ID && loaded.GROWTH_DOGFOOD_WORKSPACE_ID !== EXPECTED.workspaceId) {
    console.log(JSON.stringify({ ok: false, token: "CORA_RESEARCH_FAIL", reason: "workspace_mismatch" }, null, 2));
    process.exit(2);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: loaded.GROWTH_DOGFOOD_DATABASE_URL } } });
  try {
    const workspace = await prisma.workspace.findUnique({ where: { id: EXPECTED.workspaceId } });
    const campaign = await prisma.growthCampaign.findUnique({ where: { id: EXPECTED.campaignId } });
    const cora = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.coraProspectId } });
    const job = await prisma.growthJob.findUnique({ where: { id: EXPECTED.coraJobId } });
    const form = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.formProspectId } });
    const wb = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.workbenchProspectId } });
    const wbJob = await prisma.growthJob.findUnique({ where: { id: EXPECTED.workbenchJobId } });
    const evidenceCount = await prisma.growthEvidence.count();
    const qualCount = await prisma.growthQualification.count();
    const criticCount = await prisma.growthCriticReview.count();

    const pre = {
      staging: { host: identity.staging.redactedHost, database: identity.staging.database, classification: identity.classified.classification },
      production: { host: identity.production.redactedHost, database: identity.production.database },
      workspaceOk: workspace?.clerkUserId === SYNTHETIC_DOGFOOD_CLERK_USER_ID,
      cora: { id: cora?.id, domain: cora?.canonicalDomain, lifecycle: cora?.lifecycleState },
      job: { id: job?.id, type: job?.type, status: job?.status, prospectId: job?.prospectId },
      form: { id: form?.id, lifecycle: form?.lifecycleState },
      workbench: { id: wb?.id, lifecycle: wb?.lifecycleState, jobStatus: wbJob?.status },
      evidenceCount,
      qualCount,
      criticCount,
    };

    const issues = [];
    if (!workspace || workspace.clerkUserId !== SYNTHETIC_DOGFOOD_CLERK_USER_ID) issues.push("workspace");
    if (!campaign || campaign.workspaceId !== EXPECTED.workspaceId) issues.push("campaign");
    if (cora?.canonicalDomain !== "coraandspink.com") issues.push("cora_identity");
    if (cora?.lifecycleState !== "research_pending") issues.push("cora_lifecycle");
    if (job?.status !== "pending" || job?.type !== "research" || job?.prospectId !== EXPECTED.coraProspectId) issues.push("job");
    if (evidenceCount !== 0 || qualCount !== 0 || criticCount !== 0) issues.push("pre_rows");
    if (wb?.lifecycleState !== "research_pending" || wbJob?.status !== "pending") issues.push("workbench_pre");
    if (issues.length) {
      console.log(JSON.stringify({ ok: false, token: "CORA_RESEARCH_FAIL", reason: "preflight", issues, pre }, null, 2));
      process.exit(2);
    }

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
      jobId: EXPECTED.coraJobId,
      fetchFn,
      chatFn: forbiddenAi(aiCalls, "chat"),
      detailedChatFn: forbiddenAi(aiCalls, "detailed"),
    });

    const jobFinal = await prisma.growthJob.findUnique({ where: { id: EXPECTED.coraJobId } });
    const coraFinal = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.coraProspectId } });
    const formFinal = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.formProspectId } });
    const wbFinal = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.workbenchProspectId } });
    const wbJobFinal = await prisma.growthJob.findUnique({ where: { id: EXPECTED.workbenchJobId } });
    const formJobs = await prisma.growthJob.findMany({
      where: { prospectId: EXPECTED.formProspectId },
      select: { id: true, type: true, status: true, lastErrorCode: true },
    });
    const coraJobs = await prisma.growthJob.findMany({ where: { prospectId: EXPECTED.coraProspectId } });
    const evidence = await prisma.growthEvidence.findMany({
      where: { prospectId: EXPECTED.coraProspectId },
      orderBy: { packEvidenceId: "asc" },
    });
    const otherEvidence = await prisma.growthEvidence.count({
      where: { prospectId: { in: [EXPECTED.formProspectId, EXPECTED.workbenchProspectId] } },
    });
    const qualifications = await prisma.growthQualification.count();
    const critic = await prisma.growthCriticReview.count();
    const qualifyJobs = coraJobs.filter((j) => j.type === "qualify");

    const htmlHits = [
      ...evidence.flatMap((e) => ["claim", "observedData", "sourceUrl", "extractor"].filter((f) => containsHtml(e[f]))),
      ...(containsHtml(jobFinal?.lastErrorMessage) ? ["job_error"] : []),
    ];

    const rootFetches = fetchLog.filter((f) => f.pathname === "/" || f.pathname === "");
    const successfulRoots = rootFetches.filter((f) => f.ok);
    const effectiveRoot = successfulRoots.length ? successfulRoots[successfulRoots.length - 1].finalUrl : null;
    const secondary = fetchLog.filter((f) => f.pathname && f.pathname !== "/");

    console.log(
      JSON.stringify(
        {
          pre,
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
            job: {
              id: jobFinal.id,
              status: jobFinal.status,
              lastErrorCode: jobFinal.lastErrorCode,
              lastErrorMessage: jobFinal.lastErrorMessage,
              attempts: jobFinal.attempts,
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
  console.error(JSON.stringify({ ok: false, token: "CORA_RESEARCH_FAIL", error: String(err?.message || err).slice(0, 400) }, null, 2));
  process.exit(1);
});
