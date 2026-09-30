/**
 * Real PostgreSQL Growth constraint tests.
 *
 * Runs only when GROWTH_TEST_DATABASE_URL points at a local disposable DB
 * whose name contains "growth_test". Never uses Neon/.env.local production URLs.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { claimGrowthJob } from "../job-claim.js";
import { processGrowthJob } from "../orchestrator.js";
import { AicreditsTimeoutError } from "../../ai/aicredits.js";
import { isDisposableGrowthTestUrl } from "../test-db-url.js";

const TEST_URL = process.env.GROWTH_TEST_DATABASE_URL || "";
const RUN = isDisposableGrowthTestUrl(TEST_URL);

describe("growth real postgres constraints", { skip: RUN ? false : "GROWTH_TEST_DATABASE_URL is not a local disposable growth_test database" }, () => {
  /** @type {PrismaClient | null} */
  let db = null;
  const fixtures = [];

  before(async () => {
    if (!RUN) return;
    db = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    await db.$connect();
  });

  after(async () => {
    if (!db) return;
    for (const id of fixtures.reverse()) {
      await db.workspace.deleteMany({ where: { id } }).catch(() => {});
    }
    await db.$disconnect();
  });

  async function seedWorkspace() {
    const ws = await db.workspace.create({
      data: { clerkUserId: `growth_test_${Date.now()}_${Math.random().toString(16).slice(2)}`, email: "growth-test@example.com" },
    });
    fixtures.push(ws.id);
    const campaign = await db.growthCampaign.create({
      data: {
        workspaceId: ws.id,
        name: "Test campaign",
        status: "active",
        productName: "CartRenew",
        productUrl: "https://cartrenew.example",
        productDescription: "Recover abandoned WooCommerce checkouts.",
        goal: "find_stores",
        targetPlatform: "woocommerce",
        desiredSignals: ["checkout"],
      },
    });
    return { ws, campaign };
  }

  it("1 campaign belongs to workspace", async () => {
    const { ws, campaign } = await seedWorkspace();
    const loaded = await db.growthCampaign.findUnique({ where: { id: campaign.id } });
    assert.equal(loaded.workspaceId, ws.id);
  });

  it("2-3 unique campaignId+canonicalDomain; same domain across campaigns", async () => {
    const a = await seedWorkspace();
    const b = await seedWorkspace();
    const data = {
      originalUrl: "https://shop.example/",
      normalizedUrl: "https://shop.example",
      canonicalDomain: "shop.example",
      lifecycleState: "candidate",
    };
    await db.growthProspect.create({ data: { ...data, campaignId: a.campaign.id } });
    await assert.rejects(
      () => db.growthProspect.create({ data: { ...data, campaignId: a.campaign.id } }),
      (err) => err.code === "P2002"
    );
    const other = await db.growthProspect.create({ data: { ...data, campaignId: b.campaign.id } });
    assert.equal(other.canonicalDomain, "shop.example");
  });

  it("4-5 unique prospect+run+EV; EV-001 allowed across runs", async () => {
    const { campaign } = await seedWorkspace();
    const prospect = await db.growthProspect.create({
      data: {
        campaignId: campaign.id,
        originalUrl: "https://a.example/",
        normalizedUrl: "https://a.example",
        canonicalDomain: "a.example",
      },
    });
    await db.growthEvidence.create({
      data: { prospectId: prospect.id, runId: "run1", packEvidenceId: "EV-001", claim: "one" },
    });
    await assert.rejects(
      () =>
        db.growthEvidence.create({
          data: { prospectId: prospect.id, runId: "run1", packEvidenceId: "EV-001", claim: "dup" },
        }),
      (err) => err.code === "P2002"
    );
    const second = await db.growthEvidence.create({
      data: { prospectId: prospect.id, runId: "run2", packEvidenceId: "EV-001", claim: "other run" },
    });
    assert.equal(second.runId, "run2");
  });

  it("6 unique qualification jobId", async () => {
    const { campaign } = await seedWorkspace();
    const prospect = await db.growthProspect.create({
      data: {
        campaignId: campaign.id,
        originalUrl: "https://b.example/",
        normalizedUrl: "https://b.example",
        canonicalDomain: "b.example",
      },
    });
    const job = await db.growthJob.create({
      data: { campaignId: campaign.id, prospectId: prospect.id, type: "qualify", status: "succeeded" },
    });
    await db.growthQualification.create({
      data: {
        prospectId: prospect.id,
        jobId: job.id,
        decision: "possible_fit",
        summary: "Observed WooCommerce.",
        producedBy: "llm",
        uncertainties: [],
      },
    });
    await assert.rejects(
      () =>
        db.growthQualification.create({
          data: {
            prospectId: prospect.id,
            jobId: job.id,
            decision: "weak_fit",
            summary: "Duplicate job.",
            producedBy: "llm",
            uncertainties: [],
          },
        }),
      (err) => err.code === "P2002"
    );
  });

  it("7 unique critic qualificationId", async () => {
    const { campaign } = await seedWorkspace();
    const prospect = await db.growthProspect.create({
      data: {
        campaignId: campaign.id,
        originalUrl: "https://c.example/",
        normalizedUrl: "https://c.example",
        canonicalDomain: "c.example",
      },
    });
    const q = await db.growthQualification.create({
      data: {
        prospectId: prospect.id,
        decision: "possible_fit",
        summary: "Observed WooCommerce.",
        producedBy: "llm",
        uncertainties: [],
      },
    });
    await db.growthCriticReview.create({
      data: { qualificationId: q.id, finalVerdict: "pass", reviewState: "accepted" },
    });
    await assert.rejects(
      () => db.growthCriticReview.create({ data: { qualificationId: q.id, finalVerdict: "fail", reviewState: "rejected" } }),
      (err) => err.code === "P2002"
    );
  });

  it("8-10 deleting job SET NULLs evidence and keeps joins", async () => {
    const { campaign } = await seedWorkspace();
    const prospect = await db.growthProspect.create({
      data: {
        campaignId: campaign.id,
        originalUrl: "https://d.example/",
        normalizedUrl: "https://d.example",
        canonicalDomain: "d.example",
      },
    });
    const job = await db.growthJob.create({
      data: { campaignId: campaign.id, prospectId: prospect.id, type: "research", status: "succeeded" },
    });
    const ev = await db.growthEvidence.create({
      data: {
        prospectId: prospect.id,
        jobId: job.id,
        runId: job.id,
        packEvidenceId: "EV-001",
        claim: "Woo plugin observed.",
      },
    });
    const q = await db.growthQualification.create({
      data: {
        prospectId: prospect.id,
        decision: "possible_fit",
        summary: "Observed WooCommerce.",
        producedBy: "llm",
        uncertainties: [],
      },
    });
    const reason = await db.growthQualificationReason.create({
      data: { qualificationId: q.id, type: "observation", statement: "Woo plugin assets were observed.", sortOrder: 0 },
    });
    await db.growthQualificationReasonEvidence.create({ data: { reasonId: reason.id, evidenceId: ev.id } });
    await db.growthJob.delete({ where: { id: job.id } });
    const kept = await db.growthEvidence.findUnique({ where: { id: ev.id } });
    assert.equal(kept.jobId, null);
    const join = await db.growthQualificationReasonEvidence.findUnique({
      where: { reasonId_evidenceId: { reasonId: reason.id, evidenceId: ev.id } },
    });
    assert.ok(join);
  });

  it("11 deleting evidence removes citation joins", async () => {
    const { campaign } = await seedWorkspace();
    const prospect = await db.growthProspect.create({
      data: {
        campaignId: campaign.id,
        originalUrl: "https://e.example/",
        normalizedUrl: "https://e.example",
        canonicalDomain: "e.example",
      },
    });
    const ev = await db.growthEvidence.create({
      data: { prospectId: prospect.id, runId: "r", packEvidenceId: "EV-001", claim: "claim" },
    });
    const q = await db.growthQualification.create({
      data: {
        prospectId: prospect.id,
        decision: "possible_fit",
        summary: "Observed WooCommerce.",
        producedBy: "llm",
        uncertainties: [],
      },
    });
    const reason = await db.growthQualificationReason.create({
      data: { qualificationId: q.id, type: "observation", statement: "Woo plugin assets were observed.", sortOrder: 0 },
    });
    await db.growthQualificationReasonEvidence.create({ data: { reasonId: reason.id, evidenceId: ev.id } });
    await db.growthEvidence.delete({ where: { id: ev.id } });
    const joins = await db.growthQualificationReasonEvidence.findMany({ where: { reasonId: reason.id } });
    assert.equal(joins.length, 0);
  });

  it("12 deleting qualification removes reasons + critic", async () => {
    const { campaign } = await seedWorkspace();
    const prospect = await db.growthProspect.create({
      data: {
        campaignId: campaign.id,
        originalUrl: "https://f.example/",
        normalizedUrl: "https://f.example",
        canonicalDomain: "f.example",
      },
    });
    const q = await db.growthQualification.create({
      data: {
        prospectId: prospect.id,
        decision: "possible_fit",
        summary: "Observed WooCommerce.",
        producedBy: "llm",
        uncertainties: [],
      },
    });
    await db.growthQualificationReason.create({
      data: { qualificationId: q.id, type: "observation", statement: "Woo plugin assets were observed.", sortOrder: 0 },
    });
    await db.growthCriticReview.create({
      data: { qualificationId: q.id, finalVerdict: "pass", reviewState: "accepted" },
    });
    await db.growthQualification.delete({ where: { id: q.id } });
    assert.equal((await db.growthQualificationReason.findMany({ where: { qualificationId: q.id } })).length, 0);
    assert.equal((await db.growthCriticReview.findMany({ where: { qualificationId: q.id } })).length, 0);
  });

  it("13-15 prospect/campaign delete cascades Growth only, not Website/Audit", async () => {
    const { ws, campaign } = await seedWorkspace();
    const website = await db.website.create({
      data: { workspaceId: ws.id, domain: `keep-${Date.now()}.example`, url: "https://keep.example" },
    });
    const audit = await db.audit.create({ data: { websiteId: website.id, status: "pending" } });
    const prospect = await db.growthProspect.create({
      data: {
        campaignId: campaign.id,
        originalUrl: "https://g.example/",
        normalizedUrl: "https://g.example",
        canonicalDomain: "g.example",
      },
    });
    await db.growthJob.create({
      data: { campaignId: campaign.id, prospectId: prospect.id, type: "research", status: "pending" },
    });
    await db.growthCampaign.delete({ where: { id: campaign.id } });
    assert.equal(await db.growthProspect.count({ where: { campaignId: campaign.id } }), 0);
    assert.ok(await db.website.findUnique({ where: { id: website.id } }));
    assert.ok(await db.audit.findUnique({ where: { id: audit.id } }));
  });

  it("16 transaction rollback leaves no partial qualification graph", async () => {
    const { campaign } = await seedWorkspace();
    const prospect = await db.growthProspect.create({
      data: {
        campaignId: campaign.id,
        originalUrl: "https://h.example/",
        normalizedUrl: "https://h.example",
        canonicalDomain: "h.example",
        lifecycleState: "qualifying",
      },
    });
    await assert.rejects(() =>
      db.$transaction(async (tx) => {
        await tx.growthQualification.create({
          data: {
            prospectId: prospect.id,
            decision: "possible_fit",
            summary: "Observed WooCommerce.",
            producedBy: "llm",
            uncertainties: [],
          },
        });
        throw new Error("boom");
      })
    );
    assert.equal(await db.growthQualification.count({ where: { prospectId: prospect.id } }), 0);
  });

  it("17 concurrent claims produce exactly one winner", async () => {
    const { campaign } = await seedWorkspace();
    const prospect = await db.growthProspect.create({
      data: {
        campaignId: campaign.id,
        originalUrl: "https://i.example/",
        normalizedUrl: "https://i.example",
        canonicalDomain: "i.example",
      },
    });
    const job = await db.growthJob.create({
      data: {
        campaignId: campaign.id,
        prospectId: prospect.id,
        type: "research",
        status: "pending",
        availableAt: new Date(Date.now() - 1000),
      },
    });
    const [a, b] = await Promise.all([claimGrowthJob(db, job.id), claimGrowthJob(db, job.id)]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, ["already_claimed", "claimed"]);
  });

  it("18-19 lease expired can reclaim; unexpired cannot", async () => {
    const { campaign } = await seedWorkspace();
    const prospect = await db.growthProspect.create({
      data: {
        campaignId: campaign.id,
        originalUrl: "https://j.example/",
        normalizedUrl: "https://j.example",
        canonicalDomain: "j.example",
      },
    });
    const stale = await db.growthJob.create({
      data: {
        campaignId: campaign.id,
        prospectId: prospect.id,
        type: "research",
        status: "running",
        leaseExpiresAt: new Date(Date.now() - 1000),
        availableAt: new Date(Date.now() - 5000),
      },
    });
    const fresh = await db.growthJob.create({
      data: {
        campaignId: campaign.id,
        prospectId: prospect.id,
        type: "qualify",
        status: "running",
        leaseExpiresAt: new Date(Date.now() + 60_000),
        availableAt: new Date(Date.now() - 5000),
      },
    });
    const reclaim = await claimGrowthJob(db, stale.id);
    const blocked = await claimGrowthJob(db, fresh.id);
    assert.equal(reclaim.status, "claimed");
    assert.equal(blocked.status, "already_claimed");
  });

  it("20 duplicate qualify job is not required by unique type but app tx creates once", async () => {
    const { campaign } = await seedWorkspace();
    const prospect = await db.growthProspect.create({
      data: {
        campaignId: campaign.id,
        originalUrl: "https://k.example/",
        normalizedUrl: "https://k.example",
        canonicalDomain: "k.example",
      },
    });
    await db.growthJob.create({
      data: { campaignId: campaign.id, prospectId: prospect.id, type: "qualify", status: "pending" },
    });
    const existing = await db.growthJob.findFirst({ where: { prospectId: prospect.id, type: "qualify" } });
    assert.ok(existing);
    const again = await db.growthJob.findFirst({ where: { prospectId: prospect.id, type: "qualify" } });
    assert.equal(again.id, existing.id);
  });

  it("critic timeout leaves qualification and no review; retry succeeds once", async () => {
    const { campaign } = await seedWorkspace();
    const prospect = await db.growthProspect.create({
      data: {
        campaignId: campaign.id,
        originalUrl: "https://woo.example/",
        normalizedUrl: "https://woo.example",
        canonicalDomain: "woo.example",
        lifecycleState: "qualifying",
        platformStatus: "verified",
      },
    });
    const research = await db.growthJob.create({
      data: { campaignId: campaign.id, prospectId: prospect.id, type: "research", status: "succeeded", finishedAt: new Date() },
    });
    await db.growthEvidence.create({
      data: {
        prospectId: prospect.id,
        jobId: research.id,
        runId: research.id,
        packEvidenceId: "EV-001",
        claim: "WooCommerce plugin assets were observed.",
        extractor: "woocommerce",
      },
    });
    const qualify = await db.growthJob.create({
      data: { campaignId: campaign.id, prospectId: prospect.id, type: "qualify", status: "succeeded" },
    });
    await db.growthQualification.create({
      data: {
        prospectId: prospect.id,
        jobId: qualify.id,
        decision: "possible_fit",
        summary: "WooCommerce storefront was observed from evidence.",
        producedBy: "llm",
        shortCircuited: false,
        uncertainties: [],
      },
    });
    await db.growthQualificationReason.create({
      data: {
        qualificationId: (await db.growthQualification.findFirst({ where: { prospectId: prospect.id } })).id,
        type: "observation",
        statement: "WooCommerce plugin assets were observed on the storefront.",
        sortOrder: 0,
      },
    });
    const qrow = await db.growthQualification.findFirst({ where: { prospectId: prospect.id } });
    await db.growthQualificationReasonEvidence.create({
      data: {
        reasonId: (await db.growthQualificationReason.findFirst({ where: { qualificationId: qrow.id } })).id,
        evidenceId: (await db.growthEvidence.findFirst({ where: { prospectId: prospect.id } })).id,
      },
    });
    const critic = await db.growthJob.create({
      data: { campaignId: campaign.id, prospectId: prospect.id, type: "critic", status: "pending", availableAt: new Date() },
    });
    const timeout = await processGrowthJob({
      db,
      jobId: critic.id,
      chatFn: async () => {
        throw new AicreditsTimeoutError();
      },
    });
    assert.equal(timeout.status, "failed");
    assert.equal(await db.growthCriticReview.count({ where: { qualificationId: qrow.id } }), 0);
    assert.equal(await db.growthQualification.count({ where: { prospectId: prospect.id } }), 1);
    const after = await db.growthProspect.findUnique({ where: { id: prospect.id } });
    assert.notEqual(after.lifecycleState, "qualified");

    const retry = await db.growthJob.create({
      data: { campaignId: campaign.id, prospectId: prospect.id, type: "critic", status: "pending", availableAt: new Date() },
    });
    const ok = await processGrowthJob({
      db,
      jobId: retry.id,
      chatFn: async () =>
        JSON.stringify({
          verdict: "pass",
          items: [{ reasonIndex: 0, support: "supported", note: "ok" }],
        }),
    });
    assert.equal(ok.status, "succeeded");
    assert.equal(await db.growthCriticReview.count({ where: { qualificationId: qrow.id } }), 1);
    assert.equal(await db.growthQualification.count({ where: { prospectId: prospect.id } }), 1);
    const final = await db.growthProspect.findUnique({ where: { id: prospect.id } });
    assert.equal(final.lifecycleState, "qualified");
  });
});
