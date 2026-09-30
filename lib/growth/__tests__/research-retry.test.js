import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canTransitionProspect, nextProspectState } from "../state-machine.js";
import { enqueueFailedResearchRetry } from "../research-retry.js";
import { createFakePrisma } from "./fake-growth-db.js";

describe("failed research retry", () => {
  it("allows failed → research_pending and forbids rejected/qualified reopen", () => {
    assert.equal(canTransitionProspect("failed", "research_pending"), true);
    assert.equal(nextProspectState("failed", "reopen_failed_research"), "research_pending");
    assert.equal(canTransitionProspect("rejected", "research_pending"), false);
    assert.equal(canTransitionProspect("qualified", "research_pending"), false);
    assert.throws(() => nextProspectState("rejected", "reopen_failed_research"), /illegal_prospect_event/);
  });

  it("creates one new pending research job and leaves the failed job historical", async () => {
    const db = createFakePrisma();
    const c = db.seed.campaign();
    const p = db.seed.prospect(c);
    p.lifecycleState = "failed";
    const old = await db.seed.job(c, p, "research", { status: "failed", lastErrorCode: "RESEARCH_ROOT_FAILED" });
    const first = await enqueueFailedResearchRetry(db, { prospectId: p.id });
    assert.equal(first.ok, true);
    assert.equal(first.created, true);
    assert.notEqual(first.job.id, old.id);
    assert.equal(first.job.status, "pending");
    assert.equal(first.job.type, "research");
    const oldAfter = await db.growthJob.findUnique({ where: { id: old.id } });
    assert.equal(oldAfter.status, "failed");
    assert.equal(oldAfter.lastErrorCode, "RESEARCH_ROOT_FAILED");
    const prospect = await db.growthProspect.findUnique({ where: { id: p.id } });
    assert.equal(prospect.lifecycleState, "research_pending");

    const second = await enqueueFailedResearchRetry(db, { prospectId: p.id });
    assert.equal(second.ok, true);
    assert.equal(second.reused, true);
    assert.equal(second.job.id, first.job.id);

    prospect.lifecycleState = "failed";
    const third = await enqueueFailedResearchRetry(db, { prospectId: p.id });
    assert.equal(third.ok, true);
    assert.equal(third.reused, true);
    assert.equal(third.job.id, first.job.id);
    assert.equal((await db.growthJob.findMany({ where: { prospectId: p.id, type: "research", status: "pending" } })).length, 1);
  });

  it("does not reopen rejected or qualified prospects", async () => {
    const db = createFakePrisma();
    const c = db.seed.campaign();
    const rejected = db.seed.prospect(c, "https://rejected.example/");
    rejected.lifecycleState = "rejected";
    const r = await enqueueFailedResearchRetry(db, { prospectId: rejected.id });
    assert.equal(r.ok, false);
    assert.equal(r.error, "terminal_not_reopenable");

    const qualified = db.seed.prospect(c, "https://qualified.example/");
    qualified.lifecycleState = "qualified";
    const q = await enqueueFailedResearchRetry(db, { prospectId: qualified.id });
    assert.equal(q.ok, false);
    assert.equal(q.error, "terminal_not_reopenable");
  });
});
