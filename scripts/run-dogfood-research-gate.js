/**
 * One-shot Phase 4A research gate: process a single research job on staging.
 * Does not invoke the worker or qualification. AI chat throws if called.
 */
import { PrismaClient } from "@prisma/client";
import { assertStagingTarget, loadDogfoodEnv, SYNTHETIC_DOGFOOD_CLERK_USER_ID } from "../lib/growth/dogfood-env.js";
import { processGrowthJob } from "../lib/growth/orchestrator.js";
import { defaultResearchFetch } from "../lib/growth/research-collector.js";
import { redactId } from "../lib/growth/dogfood.js";

const EXPECTED = Object.freeze({
  workspaceId: "cmu8b10rq0000o0dc3pzc7pda",
  campaignId: "cmu8cv6zk0001o048nzo7ba6x",
  formProspectId: "cmu8cv7530003o048p9btabcy",
  formJobId: "cmu8cv7gg0005o048imw3oxcu",
  coraProspectId: "cmu8cv7lo0007o0487pn08lkb",
  workbenchProspectId: "cmu8cv7u5000bo048dqyku19u",
});

const HTML_RE = /<!DOCTYPE|<html[\s>]|<\/html>/i;
const INJECTION_RE =
  /ignore (all |any )?(previous|prior) instructions|you are (chatgpt|an? (ai|llm|language model))|system prompt|do not follow your (rules|instructions)|jailbreak/i;
const OTHER_DOMAINS = ["coraandspink.com", "theworkbenchlondon.com"];

function sanitize(text) {
  return String(text || "")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted-db-url]")
    .replace(/npg_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/\bep-[a-z0-9-]+\.[a-z0-9.-]*neon\.tech/gi, "[redacted-host]");
}

function forbiddenAi(bucket, name) {
  return async () => {
    bucket[name] += 1;
    bucket.total += 1;
    throw new Error(`AI_HARD_BLOCK: unexpected ${name} call during research gate`);
  };
}

function snapshotProspect(p, jobs) {
  const research = jobs.filter((j) => j.prospectId === p.id && j.type === "research");
  const qualify = jobs.filter((j) => j.prospectId === p.id && j.type === "qualify");
  return {
    id: p.id,
    canonicalDomain: p.canonicalDomain,
    lifecycleState: p.lifecycleState,
    platformStatus: p.platformStatus,
    researchJobs: research.map((j) => ({ id: j.id, status: j.status, attempts: j.attempts })),
    qualifyJobs: qualify.map((j) => ({ id: j.id, status: j.status })),
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

async function loadState(prisma) {
  const prospects = await prisma.growthProspect.findMany({
    where: { campaignId: EXPECTED.campaignId },
  });
  const jobs = await prisma.growthJob.findMany({
    where: { campaignId: EXPECTED.campaignId },
  });
  const evidence = await prisma.growthEvidence.findMany();
  const qualifications = await prisma.growthQualification.findMany();
  const critic = await prisma.growthCriticReview.findMany();
  return { prospects, jobs, evidence, qualifications, critic };
}

function preflightOk(state) {
  const form = state.prospects.find((p) => p.id === EXPECTED.formProspectId);
  const cora = state.prospects.find((p) => p.id === EXPECTED.coraProspectId);
  const wb = state.prospects.find((p) => p.id === EXPECTED.workbenchProspectId);
  const formJob = state.jobs.find((j) => j.id === EXPECTED.formJobId);
  const issues = [];
  if (!form || form.canonicalDomain !== "formnutrition.com") issues.push("form_identity");
  if (form?.lifecycleState !== "research_pending") issues.push("form_lifecycle");
  if (!formJob || formJob.prospectId !== EXPECTED.formProspectId || formJob.type !== "research") issues.push("form_job_identity");
  if (formJob?.status !== "pending") issues.push("form_job_status");
  if (cora?.canonicalDomain !== "coraandspink.com" || cora?.lifecycleState !== "research_pending") issues.push("cora_state");
  if (wb?.canonicalDomain !== "theworkbenchlondon.com" || wb?.lifecycleState !== "research_pending") issues.push("workbench_state");
  const coraJob = state.jobs.find((j) => j.prospectId === EXPECTED.coraProspectId && j.type === "research");
  const wbJob = state.jobs.find((j) => j.prospectId === EXPECTED.workbenchProspectId && j.type === "research");
  if (coraJob?.status !== "pending") issues.push("cora_job");
  if (wbJob?.status !== "pending") issues.push("workbench_job");
  const formEvidence = state.evidence.filter((e) => e.prospectId === EXPECTED.formProspectId);
  if (formEvidence.length !== 0) issues.push("form_evidence_not_empty");
  if (state.qualifications.length !== 0) issues.push("qualifications_not_empty");
  if (state.critic.length !== 0) issues.push("critic_not_empty");
  return { ok: issues.length === 0, issues, form, cora, wb, formJob };
}

async function main() {
  const loaded = loadDogfoodEnv();
  const identity = assertStagingTarget(loaded);
  const aiCalls = { reasoner: 0, critic: 0, detailed: 0, chat: 0, total: 0 };
  const fetchLog = [];
  const injectionHits = [];

  const report = {
    staging: identity.ok
      ? {
          host: identity.staging.redactedHost,
          database: identity.staging.database,
          classification: identity.classified.classification,
        }
      : null,
    production: identity.production
      ? { host: identity.production.redactedHost, database: identity.production.database }
      : null,
    collision: identity.token === "STAGING_DATABASE_COLLISION",
    identityOk: identity.ok,
  };

  if (!identity.ok || identity.classified.classification !== "staging") {
    console.log(JSON.stringify({ ...report, stop: "identity", token: "RESEARCH_GATE_FAIL" }, null, 2));
    process.exit(2);
  }
  if (loaded.GROWTH_DOGFOOD_WORKSPACE_ID !== EXPECTED.workspaceId) {
    console.log(JSON.stringify({ ...report, stop: "workspace_mismatch", token: "RESEARCH_GATE_FAIL" }, null, 2));
    process.exit(2);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: loaded.GROWTH_DOGFOOD_DATABASE_URL } } });
  try {
    const campaign = await prisma.growthCampaign.findUnique({ where: { id: EXPECTED.campaignId } });
    const workspace = await prisma.workspace.findUnique({ where: { id: EXPECTED.workspaceId } });
    if (!campaign || campaign.workspaceId !== EXPECTED.workspaceId) {
      console.log(JSON.stringify({ ...report, stop: "campaign_mismatch", token: "RESEARCH_GATE_FAIL" }, null, 2));
      process.exit(2);
    }
    if (!workspace || workspace.clerkUserId !== SYNTHETIC_DOGFOOD_CLERK_USER_ID) {
      console.log(JSON.stringify({ ...report, stop: "workspace_not_synthetic", token: "RESEARCH_GATE_FAIL" }, null, 2));
      process.exit(2);
    }

    const pre = await loadState(prisma);
    const gate = preflightOk(pre);
    report.preRun = {
      form: snapshotProspect(gate.form || { id: EXPECTED.formProspectId }, pre.jobs),
      cora: snapshotProspect(gate.cora || { id: EXPECTED.coraProspectId }, pre.jobs),
      workbench: snapshotProspect(gate.wb || { id: EXPECTED.workbenchProspectId }, pre.jobs),
      evidence: pre.evidence.length,
      qualifications: pre.qualifications.length,
      critic: pre.critic.length,
      issues: gate.issues,
    };
    if (!gate.ok) {
      console.log(JSON.stringify({ ...report, stop: "pre_run_assertions", token: "RESEARCH_GATE_FAIL" }, null, 2));
      process.exit(2);
    }

    const fetchFn = async (url, opts) => {
      const host = (() => {
        try {
          return new URL(url).hostname;
        } catch {
          return "";
        }
      })();
      if (OTHER_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
        throw new Error(`DOMAIN_BOUNDARY: refused fetch to ${host}`);
      }
      const res = await defaultResearchFetch(url, opts);
      const text = typeof res?.text === "string" ? res.text : "";
      const inj = text.match(INJECTION_RE);
      if (inj) {
        injectionHits.push({ url: res.finalUrl || url, match: String(inj[0]).slice(0, 80) });
      }
      fetchLog.push({
        requestedUrl: url,
        finalUrl: res?.finalUrl || null,
        ok: res?.ok !== false,
        status: res?.status ?? null,
        bytes: Buffer.byteLength(text, "utf8"),
        redirected: Boolean(res?.finalUrl && res.finalUrl !== url),
      });
      return res;
    };

    const result = await processGrowthJob({
      db: prisma,
      jobId: EXPECTED.formJobId,
      fetchFn,
      chatFn: forbiddenAi(aiCalls, "chat"),
      detailedChatFn: forbiddenAi(aiCalls, "detailed"),
    });

    const post = await loadState(prisma);
    const form = post.prospects.find((p) => p.id === EXPECTED.formProspectId);
    const cora = post.prospects.find((p) => p.id === EXPECTED.coraProspectId);
    const wb = post.prospects.find((p) => p.id === EXPECTED.workbenchProspectId);
    const formEvidence = post.evidence.filter((e) => e.prospectId === EXPECTED.formProspectId);
    const otherEvidence = post.evidence.filter((e) => e.prospectId !== EXPECTED.formProspectId);
    const formJobs = post.jobs.filter((j) => j.prospectId === EXPECTED.formProspectId);
    const researchJob = formJobs.find((j) => j.id === EXPECTED.formJobId);
    const qualifyJobs = formJobs.filter((j) => j.type === "qualify");

    const htmlHits = [];
    for (const row of formEvidence) {
      for (const field of ["claim", "observedData", "sourceUrl", "extractor", "lastErrorMessage"]) {
        if (containsHtml(row[field])) htmlHits.push({ table: "GrowthEvidence", id: row.id, field });
      }
    }
    for (const job of formJobs) {
      if (containsHtml(job.lastErrorMessage) || containsHtml(job.lastErrorCode)) {
        htmlHits.push({ table: "GrowthJob", id: job.id, field: "error" });
      }
      if (String(job.lastErrorMessage || "").length > 2000) {
        htmlHits.push({ table: "GrowthJob", id: job.id, field: "oversized_error" });
      }
    }
    if (containsHtml(form?.platformStatus)) htmlHits.push({ table: "GrowthProspect", field: "platformStatus" });

    const evIds = formEvidence.map((e) => e.packEvidenceId);
    const duplicateEv = evIds.filter((id, i) => evIds.indexOf(id) !== i);
    const runIds = [...new Set(formEvidence.map((e) => e.runId))];

    report.researchResult = {
      status: result.status,
      errorCode: result.errorCode || null,
      stage: result.stage || null,
      runId: result.runId || null,
      evidenceCount: result.evidenceCount ?? null,
      nextJobId: result.nextJobId || null,
      warnings: (result.warnings || []).map((w) => ({
        code: w.code,
        message: sanitize(w.message || "").slice(0, 240),
        url: w.url || null,
      })),
    };
    report.network = {
      requests: fetchLog.length,
      pagesOk: fetchLog.filter((f) => f.ok).length,
      fetchLog,
    };
    report.aiCalls = aiCalls;
    report.injectionHits = injectionHits;
    report.form = {
      prospect: snapshotProspect(form, post.jobs),
      platformStatus: form?.platformStatus || null,
      researchJob: researchJob
        ? { id: researchJob.id, status: researchJob.status, attempts: researchJob.attempts, lastErrorCode: researchJob.lastErrorCode }
        : null,
      qualifyJobs: qualifyJobs.map((j) => ({ id: j.id, status: j.status })),
      evidence: formEvidence.map((e) => ({
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
    };
    report.others = {
      cora: snapshotProspect(cora, post.jobs),
      workbench: snapshotProspect(wb, post.jobs),
      otherEvidence: otherEvidence.length,
    };
    report.counts = {
      qualifications: post.qualifications.length,
      critic: post.critic.length,
      formEvidence: formEvidence.length,
      duplicatePackEvidenceIds: duplicateEv,
      runIds,
      htmlPersistenceHits: htmlHits,
      researchJobsExecuted: researchJob?.status === "pending" ? 0 : 1,
    };
    report.workspaceIdRedacted = redactId(EXPECTED.workspaceId);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, token: "RESEARCH_GATE_FAIL", error: sanitize(String(err?.message || err)).slice(0, 400) }, null, 2));
  process.exit(1);
});
