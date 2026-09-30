/**
 * Phase 4A.5 — Cora reasoner only, fresh evidence pack.
 * Does not research, does not run critic, does not touch other prospects.
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { assertStagingTarget, loadDogfoodEnv, SYNTHETIC_DOGFOOD_CLERK_USER_ID } from "../lib/growth/dogfood-env.js";
import { processGrowthJob } from "../lib/growth/orchestrator.js";
import { getAicreditsConfig, aicreditsChatDetailed } from "../lib/ai/aicredits.js";

const EXPECTED = Object.freeze({
  workspaceId: "cmu8b10rq0000o0dc3pzc7pda",
  campaignId: "cmu8cv6zk0001o048nzo7ba6x",
  coraProspectId: "cmu8cv7lo0007o0487pn08lkb",
  freshRunId: "cmu8f5w770001o0n4z1ym99pe",
  qualifyJobId: "cmu8f660z000no0n48d3owtld",
  historicalRunId: "cmu8cv7ra0009o048d3e2o32s",
  historicalQualifyJobId: "cmu8ebml4000zo0io034ebd9e",
  formProspectId: "cmu8cv7530003o048p9btabcy",
  workbenchProspectId: "cmu8cv7u5000bo048dqyku19u",
  workbenchJobId: "cmu8cv7zv000do048hf9eimqz",
});

const FRESH_EV = new Set([
  "EV-001",
  "EV-002",
  "EV-003",
  "EV-004",
  "EV-005",
  "EV-006",
  "EV-007",
  "EV-008",
  "EV-009",
  "EV-010",
]);

function loadLocalEnv() {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(process.cwd(), name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] == null || process.env[key] === "") process.env[key] = val;
    }
  }
}

function fail(reason, extra = {}) {
  console.log(JSON.stringify({ ok: false, token: "CORA_REASONER_FAIL", reason, ...extra }, null, 2));
  process.exit(2);
}

function jobView(j) {
  if (!j) return null;
  return { id: j.id, type: j.type, status: j.status, lastErrorCode: j.lastErrorCode || null, attempts: j.attempts };
}

async function main() {
  loadLocalEnv();
  const loaded = loadDogfoodEnv();
  const identity = assertStagingTarget(loaded);
  if (!identity.ok || identity.classified.classification !== "staging") {
    fail("staging_identity");
  }
  const aiCfg = getAicreditsConfig();
  if (!aiCfg.configured) {
    console.log(JSON.stringify({ ok: false, token: "CORA_REASONER_TECHNICAL_FAILURE", reason: "aicredits_not_configured" }, null, 2));
    process.exit(2);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: loaded.GROWTH_DOGFOOD_DATABASE_URL } } });
  const aiCalls = { reasoner: 0, critic: 0, total: 0 };

  try {
    const workspace = await prisma.workspace.findUnique({ where: { id: EXPECTED.workspaceId } });
    const campaign = await prisma.growthCampaign.findUnique({ where: { id: EXPECTED.campaignId } });
    const cora = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.coraProspectId } });
    const qualifyJob = await prisma.growthJob.findUnique({ where: { id: EXPECTED.qualifyJobId } });
    const freshResearch = await prisma.growthJob.findUnique({ where: { id: EXPECTED.freshRunId } });
    const historicalResearch = await prisma.growthJob.findUnique({ where: { id: EXPECTED.historicalRunId } });
    const historicalQualify = await prisma.growthJob.findUnique({ where: { id: EXPECTED.historicalQualifyJobId } });
    const form = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.formProspectId } });
    const wb = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.workbenchProspectId } });
    const wbJob = await prisma.growthJob.findUnique({ where: { id: EXPECTED.workbenchJobId } });
    const latestResearch = await prisma.growthJob.findFirst({
      where: { prospectId: EXPECTED.coraProspectId, type: "research", status: "succeeded" },
      orderBy: { finishedAt: "desc" },
    });
    const freshEvidence = await prisma.growthEvidence.findMany({
      where: { prospectId: EXPECTED.coraProspectId, runId: EXPECTED.freshRunId },
      orderBy: { packEvidenceId: "asc" },
    });
    const historicalEvidence = await prisma.growthEvidence.count({
      where: { prospectId: EXPECTED.coraProspectId, runId: EXPECTED.historicalRunId },
    });
    const preQual = await prisma.growthQualification.count();
    const preCritic = await prisma.growthCriticReview.count();

    const pre = {
      staging: { env: loaded.GROWTH_DOGFOOD_ENV, host: identity.staging.redactedHost, database: identity.staging.database },
      workspaceOk: workspace?.clerkUserId === SYNTHETIC_DOGFOOD_CLERK_USER_ID,
      cora: { id: cora?.id, lifecycle: cora?.lifecycleState, platformStatus: cora?.platformStatus },
      qualifyJob: jobView(qualifyJob),
      latestSucceededResearchId: latestResearch?.id || null,
      freshResearch: jobView(freshResearch),
      historicalResearch: jobView(historicalResearch),
      historicalQualify: jobView(historicalQualify),
      freshEvidenceCount: freshEvidence.length,
      historicalEvidenceCount: historicalEvidence,
      formLifecycle: form?.lifecycleState,
      workbench: { lifecycle: wb?.lifecycleState, jobStatus: wbJob?.status },
      preQual,
      preCritic,
      aicreditsConfigured: true,
    };

    const issues = [];
    if (!workspace || workspace.clerkUserId !== SYNTHETIC_DOGFOOD_CLERK_USER_ID) issues.push("workspace");
    if (!campaign || campaign.workspaceId !== EXPECTED.workspaceId) issues.push("campaign");
    if (cora?.canonicalDomain !== "coraandspink.com") issues.push("cora_identity");
    if (qualifyJob?.type !== "qualify" || qualifyJob?.status !== "pending" || qualifyJob?.prospectId !== EXPECTED.coraProspectId) {
      issues.push("qualify_job");
    }
    if (freshResearch?.status !== "succeeded") issues.push("fresh_research");
    if (latestResearch?.id !== EXPECTED.freshRunId) issues.push("latest_research_not_fresh");
    if (freshEvidence.length !== 10) issues.push("fresh_evidence_count");
    if (freshEvidence.some((e) => !FRESH_EV.has(e.packEvidenceId))) issues.push("fresh_ev_ids");
    if (historicalEvidence !== 17) issues.push("historical_evidence");
    if (historicalQualify?.status !== "cancelled") issues.push("historical_qualify_not_cancelled");
    if (preQual !== 0 || preCritic !== 0) issues.push("pre_qual_critic");
    if (form?.lifecycleState !== "failed") issues.push("form");
    if (wb?.lifecycleState !== "research_pending" || wbJob?.status !== "pending") issues.push("workbench");
    if (issues.length) fail("preflight", { issues, pre });

    const detailedChatFn = async (model, messages, opts) => {
      aiCalls.total += 1;
      aiCalls.reasoner += 1;
      if (aiCalls.reasoner > 1 || aiCalls.total > 1) {
        aiCalls.critic += 1;
        throw new Error("AI_HARD_BLOCK: second AI call forbidden in Cora reasoner gate");
      }
      return aicreditsChatDetailed(model, messages, opts);
    };

    const outcome = await processGrowthJob({
      db: prisma,
      jobId: EXPECTED.qualifyJobId,
      detailedChatFn,
      fetchFn: async (url) => {
        throw new Error(`DOMAIN_BOUNDARY: research fetch forbidden during qualify (${String(url).slice(0, 80)})`);
      },
    });

    const jobFinal = await prisma.growthJob.findUnique({ where: { id: EXPECTED.qualifyJobId } });
    const coraFinal = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.coraProspectId } });
    const formFinal = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.formProspectId } });
    const wbFinal = await prisma.growthProspect.findUnique({ where: { id: EXPECTED.workbenchProspectId } });
    const wbJobFinal = await prisma.growthJob.findUnique({ where: { id: EXPECTED.workbenchJobId } });
    const qualification = await prisma.growthQualification.findFirst({
      where: { jobId: EXPECTED.qualifyJobId },
      include: {
        reasons: {
          orderBy: { sortOrder: "asc" },
          include: { evidenceLinks: { include: { evidence: true } } },
        },
      },
    });
    const criticJob = await prisma.growthJob.findFirst({
      where: { prospectId: EXPECTED.coraProspectId, type: "critic" },
      orderBy: { createdAt: "desc" },
    });
    const criticRows = await prisma.growthCriticReview.count();
    const historicalStill = await prisma.growthEvidence.count({
      where: { prospectId: EXPECTED.coraProspectId, runId: EXPECTED.historicalRunId },
    });
    const formJobs = await prisma.growthJob.findMany({
      where: { prospectId: EXPECTED.formProspectId },
      select: { id: true, type: true, status: true, lastErrorCode: true },
    });

    const reasons = (qualification?.reasons || []).map((r) => {
      const citations = (r.evidenceLinks || []).map((link) => ({
        evidenceId: link.evidenceId,
        packEvidenceId: link.evidence?.packEvidenceId || null,
        runId: link.evidence?.runId || null,
        claim: link.evidence?.claim || null,
        observedData: link.evidence?.observedData || null,
        extractor: link.evidence?.extractor || null,
      }));
      return {
        id: r.id,
        type: r.type,
        statement: r.statement,
        sortOrder: r.sortOrder,
        citedPackIds: citations.map((c) => c.packEvidenceId),
        citations,
      };
    });

    const contamination = reasons.flatMap((r) =>
      r.citations.filter((c) => c.runId !== EXPECTED.freshRunId || !FRESH_EV.has(c.packEvidenceId))
    );
    const invalidCitations = reasons.flatMap((r) => r.citations.filter((c) => !c.packEvidenceId || !c.evidenceId));
    const citedOutsidePack = reasons.flatMap((r) => r.citedPackIds.filter((id) => !FRESH_EV.has(id)));

    console.log(
      JSON.stringify(
        {
          pre,
          outcome: {
            status: outcome.status,
            errorCode: outcome.errorCode || null,
            qualificationId: outcome.qualificationId || null,
            shortCircuited: outcome.shortCircuited || false,
            reasonerCalls: outcome.reasonerCalls ?? null,
            criticCalls: outcome.criticCalls ?? null,
            nextJobId: outcome.nextJobId || null,
          },
          qualification: qualification
            ? {
                id: qualification.id,
                decision: qualification.decision,
                summary: qualification.summary,
                producedBy: qualification.producedBy,
                shortCircuited: qualification.shortCircuited,
                structuralOk: qualification.structuralOk,
                reasonerModel: qualification.reasonerModel,
                reasonerProvider: qualification.reasonerProvider,
                reasonerCallCount: qualification.reasonerCallCount,
                promptTokens: qualification.promptTokens,
                completionTokens: qualification.completionTokens,
                totalTokens: qualification.totalTokens,
                uncertainties: qualification.uncertainties,
                reasons,
              }
            : null,
          qualifyJob: jobView(jobFinal),
          criticJob: jobView(criticJob),
          criticRows,
          cora: {
            lifecycle: coraFinal.lifecycleState,
            latestQualificationDecision: coraFinal.latestQualificationDecision,
            latestReviewState: coraFinal.latestReviewState,
          },
          contaminationCount: contamination.length,
          invalidCitationCount: invalidCitations.length + citedOutsidePack.length,
          contamination,
          citedOutsidePack,
          historicalEvidenceCount: historicalStill,
          others: {
            form: { lifecycle: formFinal.lifecycleState, jobs: formJobs },
            workbench: { lifecycle: wbFinal.lifecycleState, job: jobView(wbJobFinal) },
          },
          aiCalls,
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
  console.error(
    JSON.stringify(
      {
        ok: false,
        token: "CORA_REASONER_TECHNICAL_FAILURE",
        error: String(err?.message || err).slice(0, 400),
      },
      null,
      2
    )
  );
  process.exit(1);
});
