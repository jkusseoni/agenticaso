import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canTransitionProspect, nextProspectState } from "../state-machine.js";
import { enqueueGrowthResearchRefresh, RESEARCH_REFRESH_REASON } from "../research-refresh.js";
import { persistResearchSuccess } from "../persist-run.js";
import { createFakePrisma } from "./fake-growth-db.js";

async function seedQualificationPending(db) {
  const c = db.seed.campaign();
  const p = db.seed.prospect(c);
  p.lifecycleState = "qualification_pending";
  p.platformStatus = "verified";
  const research = await db.seed.job(c, p, "research", { status: "succeeded" });
  const qualify = await db.seed.job(c, p, "qualify", { status: "pending" });
  await db.growthEvidence.create({
    data: {
      prospectId: p.id,
      jobId: research.id,
      runId: research.id,
      packEvidenceId: "EV-001",
      claim: "historical woo path",
      sourceUrl: "https://shop.example/",
      sourceType: "path",
      observedData: "/wp-content/plugins/woocommerce/",
      confidence: 0.95,
      verificationStatus: "observed",
      extractor: "woocommerce_plugin_path",
    },
  });
  return { c, p, research, qualify };
}

describe("enqueueGrowthResearchRefresh", () => {
  it("allows qualification_pending → research_pending and forbids qualified/rejected reopen", () => {
    assert.equal(canTransitionProspect("qualification_pending", "research_pending"), true);
    assert.equal(nextProspectState("qualification_pending", "refresh_research"), "research_pending");
    assert.equal(canTransitionProspect("qualified", "research_pending"), false);
    assert.equal(canTransitionProspect("rejected", "research_pending"), false);
    assert.throws(() => nextProspectState("qualified", "refresh_research"), /illegal_prospect_event/);
    assert.throws(() => nextProspectState("rejected", "refresh_research"), /illegal_prospect_event/);
  });

  it("cancels stale qualify, preserves historical research/evidence, and creates one new research job", async () => {
    const db = createFakePrisma();
    const { p, research, qualify } = await seedQualificationPending(db);
    const first = await enqueueGrowthResearchRefresh(db, { prospectId: p.id });
    assert.equal(first.ok, true);
    assert.equal(first.created, true);
    assert.equal(first.reused, false);
    assert.notEqual(first.job.id, research.id);
    assert.equal(first.job.type, "research");
    assert.equal(first.job.status, "pending");
    assert.deepEqual(first.cancelledQualifyJobIds, [qualify.id]);

    const prospect = await db.growthProspect.findUnique({ where: { id: p.id } });
    assert.equal(prospect.lifecycleState, "research_pending");

    const oldResearch = await db.growthJob.findUnique({ where: { id: research.id } });
    assert.equal(oldResearch.status, "succeeded");
    const oldQualify = await db.growthJob.findUnique({ where: { id: qualify.id } });
    assert.equal(oldQualify.status, "cancelled");
    assert.equal(oldQualify.lastErrorCode, RESEARCH_REFRESH_REASON);

    const evidence = await db.growthEvidence.findMany({ where: { prospectId: p.id } });
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].runId, research.id);
    assert.equal(evidence[0].packEvidenceId, "EV-001");
    assert.equal((await db.growthJob.findMany({ where: { prospectId: p.id, type: "research", status: "pending" } })).length, 1);
  });

  it("is idempotent and does not double-cancel or duplicate pending research", async () => {
    const db = createFakePrisma();
    const { p, qualify } = await seedQualificationPending(db);
    const first = await enqueueGrowthResearchRefresh(db, { prospectId: p.id });
    const second = await enqueueGrowthResearchRefresh(db, { prospectId: p.id });
    assert.equal(second.ok, true);
    assert.equal(second.reused, true);
    assert.equal(second.created, false);
    assert.equal(second.job.id, first.job.id);
    assert.deepEqual(second.cancelledQualifyJobIds, []);
    const pendingResearch = await db.growthJob.findMany({
      where: { prospectId: p.id, type: "research", status: "pending" },
    });
    assert.equal(pendingResearch.length, 1);
    const qualifyAfter = await db.growthJob.findUnique({ where: { id: qualify.id } });
    assert.equal(qualifyAfter.status, "cancelled");
    const cancelledQualify = await db.growthJob.findMany({
      where: { prospectId: p.id, type: "qualify", status: "cancelled" },
    });
    assert.equal(cancelledQualify.length, 1);
  });

  it("does not reopen qualified or rejected prospects", async () => {
    const db = createFakePrisma();
    const c = db.seed.campaign();
    const qualified = db.seed.prospect(c, "https://qualified.example/");
    qualified.lifecycleState = "qualified";
    const q = await enqueueGrowthResearchRefresh(db, { prospectId: qualified.id });
    assert.equal(q.ok, false);
    assert.equal(q.error, "terminal_not_reopenable");

    const rejected = db.seed.prospect(c, "https://rejected.example/");
    rejected.lifecycleState = "rejected";
    const r = await enqueueGrowthResearchRefresh(db, { prospectId: rejected.id });
    assert.equal(r.ok, false);
    assert.equal(r.error, "terminal_not_reopenable");
  });

  it("does not delete qualification or critic rows", async () => {
    const db = createFakePrisma();
    const { c, p, research, qualify } = await seedQualificationPending(db);
    const qual = await db.growthQualification.create({
      data: { prospectId: p.id, jobId: qualify.id, decision: "possible_fit", summary: "kept" },
    });
    await db.growthCriticReview.create({
      data: { qualificationId: qual.id, finalVerdict: "pass", reviewState: "accepted" },
    });
    const beforeQual = db.state.qualifications.length;
    const beforeCritic = db.state.critics.length;
    const result = await enqueueGrowthResearchRefresh(db, { prospectId: p.id });
    assert.equal(result.ok, true);
    assert.equal(db.state.qualifications.length, beforeQual);
    assert.equal(db.state.critics.length, beforeCritic);
    assert.equal(db.state.qualifications[0].id, qual.id);
    assert.equal((await db.growthJob.findUnique({ where: { id: research.id } })).status, "succeeded");
  });

  it("lets a later research success create a new pending qualify job without reviving the cancelled one", async () => {
    const db = createFakePrisma();
    const { c, p, qualify } = await seedQualificationPending(db);
    const refresh = await enqueueGrowthResearchRefresh(db, { prospectId: p.id });
    const fresh = await db.growthJob.findUnique({ where: { id: refresh.job.id } });
    fresh.status = "running";
    p.lifecycleState = "researching";
    const persisted = await persistResearchSuccess(db, {
      job: fresh,
      prospect: p,
      pack: {
        evidence: [
          {
            id: "EV-001",
            claim: "Woo plugin path.",
            sourceUrl: "https://shop.example/",
            sourceType: "path",
            observedData: "/wp-content/plugins/woocommerce/",
            confidence: 0.95,
            verificationStatus: "observed",
            extractor: "woocommerce_plugin_path",
          },
        ],
        platform: { status: "verified" },
      },
      now: new Date(),
    });
    assert.notEqual(persisted.qualifyJob.id, qualify.id);
    assert.equal(persisted.qualifyJob.status, "pending");
    const oldQualify = await db.growthJob.findUnique({ where: { id: qualify.id } });
    assert.equal(oldQualify.status, "cancelled");
    const pendingQualify = await db.growthJob.findMany({
      where: { prospectId: p.id, type: "qualify", status: "pending" },
    });
    assert.equal(pendingQualify.length, 1);
    assert.equal(pendingQualify[0].id, persisted.qualifyJob.id);
  });
});
