import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { AicreditsTimeoutError } from "../../ai/aicredits.js";
import { claimGrowthJob } from "../job-claim.js";
import {
  processGrowthJob,
  processGrowthProspect,
  createGrowthAiBudget,
  GROWTH_ERROR_CODES,
} from "../orchestrator.js";
import { createFakePrisma } from "./fake-growth-db.js";

const WOO_HTML = fs.readFileSync(path.join(process.cwd(), "lib/growth/__tests__/fixtures/woo-home.html"), "utf8");
const SHOPIFY_HTML = fs.readFileSync(path.join(process.cwd(), "lib/growth/__tests__/fixtures/shopify.html"), "utf8");

function htmlFetch(homeHtml, extras = {}) {
  return async (url) => {
    if (extras.failRoot) return { ok: false, status: 500, text: "", headers: {}, finalUrl: url };
    if (extras.timeoutRoot) throw new Error("timeout");
    if (String(url).includes("contact") && extras.failSecondary) {
      return { ok: false, status: 500, text: "", headers: {}, finalUrl: url };
    }
    const html = extras.pages?.[url] || homeHtml;
    if (extras.contactLink && !String(url).includes("contact") && !homeHtml.includes("contact")) {
      return {
        ok: true,
        status: 200,
        text: homeHtml.replace("</body>", '<a href="/contact-us">Contact</a></body>'),
        headers: {},
        finalUrl: url,
      };
    }
    return { ok: true, status: 200, text: html, headers: {}, finalUrl: url };
  };
}

function reasonerJson(ids = ["EV-001"]) {
  return JSON.stringify({
    decision: "possible_fit",
    summary: "WooCommerce storefront was observed from evidence.",
    reasons: [
      {
        type: "observation",
        statement: "WooCommerce plugin assets were observed on the storefront.",
        evidenceIds: ids,
      },
    ],
    uncertainties: [],
  });
}

function criticJson(verdict = "pass") {
  return JSON.stringify({
    verdict,
    items: [{ reasonIndex: 0, support: verdict === "fail" ? "unsupported" : "supported", note: "checked" }],
  });
}

function stageChat(reasoner, critic) {
  let n = 0;
  return async () => {
    n += 1;
    if (n === 1) return reasoner;
    return critic;
  };
}

describe("growth job claim", () => {
  it("atomically claims pending → running", async () => {
    const db = createFakePrisma();
    const c = db.seed.campaign();
    const p = db.seed.prospect(c);
    const job = await db.seed.job(c, p, "research");
    const result = await claimGrowthJob(db, job.id);
    assert.equal(result.status, "claimed");
    assert.equal(result.job.status, "running");
    assert.equal(result.job.attempts, 1);
    assert.ok(result.job.claimedAt);
    assert.ok(result.job.leaseExpiresAt);
  });

  it("second concurrent claim fails", async () => {
    const db = createFakePrisma();
    const c = db.seed.campaign();
    const p = db.seed.prospect(c);
    const job = await db.seed.job(c, p, "research");
    const [a, b] = await Promise.all([claimGrowthJob(db, job.id), claimGrowthJob(db, job.id)]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, ["already_claimed", "claimed"]);
  });

  it("does not claim a not-due job", async () => {
    const db = createFakePrisma();
    const c = db.seed.campaign();
    const p = db.seed.prospect(c);
    const job = await db.seed.job(c, p, "research", { availableAt: new Date(Date.now() + 60_000) });
    const result = await claimGrowthJob(db, job.id);
    assert.equal(result.status, "not_due");
  });

  it("does not claim a terminal job", async () => {
    const db = createFakePrisma();
    const c = db.seed.campaign();
    const p = db.seed.prospect(c);
    const job = await db.seed.job(c, p, "research", { status: "succeeded" });
    const result = await claimGrowthJob(db, job.id);
    assert.equal(result.status, "terminal");
  });
});

describe("research stage", () => {
  it("persists sanitized evidence and never raw HTML", async () => {
    const db = createFakePrisma();
    const c = db.seed.campaign();
    const p = db.seed.prospect(c);
    const out = await processGrowthProspect({
      db,
      campaignId: c.id,
      prospectId: p.id,
      fetchFn: htmlFetch(WOO_HTML),
      chatFn: stageChat(reasonerJson(), criticJson("pass")),
    });
    assert.equal(out.outcomes[0].status, "succeeded");
    assert.ok(db.state.evidence.length >= 1);
    const blob = JSON.stringify(db.state.evidence);
    assert.equal(/<!DOCTYPE|<html[\s>]|<\/html>/i.test(blob), false);
    assert.equal(blob.includes(WOO_HTML.slice(0, 40)), false);
    const prospect = db.state.prospects[0];
    assert.ok(["qualification_pending", "qualifying", "qualified", "needs_review"].includes(prospect.lifecycleState));
  });

  it("duplicate research execution does not duplicate evidence", async () => {
    const db = createFakePrisma();
    const c = db.seed.campaign();
    const p = db.seed.prospect(c);
    await processGrowthProspect({ db, campaignId: c.id, prospectId: p.id, fetchFn: htmlFetch(WOO_HTML), chatFn: async () => reasonerJson() });
    const count = db.state.evidence.length;
    const research = db.state.jobs.find((j) => j.type === "research");
    const again = await processGrowthJob({ db, jobId: research.id, fetchFn: htmlFetch(WOO_HTML) });
    assert.equal(again.status, "already_complete");
    assert.equal(db.state.evidence.length, count);
  });

  it("research success creates qualify job exactly once", async () => {
    const db = createFakePrisma();
    const c = db.seed.campaign();
    const p = db.seed.prospect(c);
    await processGrowthJob({
      db,
      jobId: (await (async () => {
        p.lifecycleState = "research_pending";
        return db.seed.job(c, p, "research");
      })()).id,
      fetchFn: htmlFetch(WOO_HTML),
    });
    await processGrowthJob({
      db,
      jobId: db.state.jobs.find((j) => j.type === "research").id,
      fetchFn: htmlFetch(WOO_HTML),
    });
    const qualify = db.state.jobs.filter((j) => j.type === "qualify");
    assert.equal(qualify.length, 1);
  });

  it("root failure creates no fake evidence and does not enqueue qualify", async () => {
    const db = createFakePrisma();
    const c = db.seed.campaign();
    const p = db.seed.prospect(c);
    p.lifecycleState = "research_pending";
    const job = await db.seed.job(c, p, "research");
    const result = await processGrowthJob({ db, jobId: job.id, fetchFn: htmlFetch("", { failRoot: true }) });
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, GROWTH_ERROR_CODES.RESEARCH_ROOT_FAILED);
    assert.equal(db.state.evidence.length, 0);
    assert.equal(db.state.jobs.filter((j) => j.type === "qualify").length, 0);
    assert.equal(db.state.prospects[0].lifecycleState, "failed");
  });

  it("persists RESEARCH_ROOT_FORBIDDEN without HTML after host-variant attempts", async () => {
    const db = createFakePrisma();
    const c = db.seed.campaign();
    const p = db.seed.prospect(c);
    p.lifecycleState = "research_pending";
    const job = await db.seed.job(c, p, "research");
    const result = await processGrowthJob({
      db,
      jobId: job.id,
      fetchFn: async (url) => ({ ok: false, status: 403, text: "<html>nope</html>", headers: {}, finalUrl: url }),
      chatFn: async () => {
        throw new Error("AI_HARD_BLOCK");
      },
    });
    assert.equal(result.errorCode, GROWTH_ERROR_CODES.RESEARCH_ROOT_FORBIDDEN);
    assert.equal(result.variantAttempted, true);
    const failed = await db.growthJob.findUnique({ where: { id: job.id } });
    assert.equal(failed.lastErrorCode, GROWTH_ERROR_CODES.RESEARCH_ROOT_FORBIDDEN);
    assert.equal(/<html|nope/i.test(failed.lastErrorMessage), false);
    assert.equal(db.state.evidence.length, 0);
    assert.equal(db.state.jobs.filter((j) => j.type === "qualify").length, 0);
  });

  it("secondary-page warning can still complete research", async () => {
    const db = createFakePrisma();
    const c = db.seed.campaign();
    const p = db.seed.prospect(c);
    p.lifecycleState = "research_pending";
    const home = WOO_HTML.replace("</body>", '<a href="/contact-us">Contact</a></body>');
    const job = await db.seed.job(c, p, "research");
    const result = await processGrowthJob({
      db,
      jobId: job.id,
      fetchFn: htmlFetch(home, { failSecondary: true }),
    });
    assert.equal(result.status, "succeeded");
    assert.ok((result.warnings || []).length >= 1);
    assert.ok(db.state.jobs.some((j) => j.type === "qualify"));
  });
});

describe("qualification and critic stages", () => {
  async function researched(db, html = WOO_HTML) {
    const c = db.seed.campaign();
    const p = db.seed.prospect(c);
    p.lifecycleState = "research_pending";
    const job = await db.seed.job(c, p, "research");
    await processGrowthJob({ db, jobId: job.id, fetchFn: htmlFetch(html) });
    return { c, p };
  }

  it("qualification uses evidence only from the correct run", async () => {
    const db = createFakePrisma();
    const { c, p } = await researched(db);
    const runA = db.state.jobs.find((j) => j.type === "research").id;
    db.state.evidence.push({
      id: "other_ev",
      prospectId: p.id,
      jobId: "other",
      runId: "other-run",
      packEvidenceId: "EV-009",
      claim: "from another run",
    });
    const qualify = db.state.jobs.find((j) => j.type === "qualify");
    await processGrowthJob({
      db,
      jobId: qualify.id,
      chatFn: async () => reasonerJson(["EV-001"]),
    });
    const links = db.state.reasonEvidence;
    assert.ok(links.length >= 1);
    for (const link of links) {
      const ev = db.state.evidence.find((e) => e.id === link.evidenceId);
      assert.equal(ev.runId, runA);
      assert.notEqual(ev.packEvidenceId, "EV-009");
    }
    const camp = c;
    void camp;
  });

  it("EV-001 from another run cannot resolve as EV-003 missing from this run", async () => {
    const db = createFakePrisma();
    const { p } = await researched(db);
    db.state.evidence.push({
      id: "foreign",
      prospectId: p.id,
      runId: "other-run",
      packEvidenceId: "EV-099",
      claim: "foreign",
    });
    const qualify = db.state.jobs.find((j) => j.type === "qualify");
    const result = await processGrowthJob({
      db,
      jobId: qualify.id,
      chatFn: async () => reasonerJson(["EV-099"]),
    });
    assert.equal(result.status, "failed");
    assert.equal(db.state.qualifications.length, 0);
  });

  it("deterministic platform short-circuit uses zero AI calls", async () => {
    const db = createFakePrisma();
    const { p } = await researched(db, SHOPIFY_HTML);
    let calls = 0;
    const qualify = db.state.jobs.find((j) => j.type === "qualify");
    const result = await processGrowthJob({
      db,
      jobId: qualify.id,
      chatFn: async () => {
        calls += 1;
        return reasonerJson();
      },
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.shortCircuited, true);
    assert.equal(calls, 0);
    assert.equal(db.state.qualifications[0].producedBy, "deterministic");
    assert.equal(db.state.qualifications[0].shortCircuited, true);
    assert.equal(db.state.qualifications[0].reasonerModel, null);
    assert.equal(db.state.prospects[0].lifecycleState, "rejected");
    assert.equal(db.state.jobs.filter((j) => j.type === "critic").length, 0);
    void p;
  });

  it("LLM qualification persists model/version/token provenance", async () => {
    const db = createFakePrisma();
    const { p } = await researched(db);
    const qualify = db.state.jobs.find((j) => j.type === "qualify");
    await processGrowthJob({
      db,
      jobId: qualify.id,
      detailedChatFn: async (model) => ({
        content: reasonerJson(),
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        model,
        ok: true,
      }),
    });
    const q = db.state.qualifications[0];
    assert.equal(q.reasonerProvider, "aicredits");
    assert.ok(q.reasonerModel);
    assert.equal(q.promptTokens, 11);
    assert.equal(q.totalTokens, 18);
    assert.equal(q.reasonerPromptVersion, 1);
    void p;
  });

  it("multiple reasons map to correct evidence rows", async () => {
    const db = createFakePrisma();
    const { p } = await researched(db);
    const ids = db.state.evidence.filter((e) => e.prospectId === p.id).map((e) => e.packEvidenceId);
    const a = ids[0];
    const b = ids[1] || ids[0];
    const qualify = db.state.jobs.find((j) => j.type === "qualify");
    await processGrowthJob({
      db,
      jobId: qualify.id,
      chatFn: async () =>
        JSON.stringify({
          decision: "possible_fit",
          summary: "Two observations from the pack.",
          reasons: [
            { type: "observation", statement: "First observed fact from the storefront pack.", evidenceIds: [a] },
            { type: "observation", statement: "Second observed fact from the storefront pack.", evidenceIds: [b] },
          ],
          uncertainties: [],
        }),
    });
    assert.equal(db.state.reasons.length, 2);
    assert.ok(db.state.reasonEvidence.length >= 2);
  });

  it("unknown evidence ID prevents trusted persistence", async () => {
    const db = createFakePrisma();
    await researched(db);
    const qualify = db.state.jobs.find((j) => j.type === "qualify");
    const result = await processGrowthJob({
      db,
      jobId: qualify.id,
      chatFn: async () => reasonerJson(["EV-999"]),
    });
    assert.equal(result.status, "failed");
    assert.equal(db.state.qualifications.length, 0);
    assert.equal(db.state.prospects[0].latestQualificationDecision, null);
  });

  it("qualification stage is idempotent", async () => {
    const db = createFakePrisma();
    await researched(db);
    const qualify = db.state.jobs.find((j) => j.type === "qualify");
    await processGrowthJob({ db, jobId: qualify.id, chatFn: async () => reasonerJson() });
    const count = db.state.qualifications.length;
    const again = await processGrowthJob({ db, jobId: qualify.id, chatFn: async () => reasonerJson() });
    assert.equal(again.status, "already_complete");
    assert.equal(db.state.qualifications.length, count);
  });

  it("critic fail → rejected", async () => {
    const db = createFakePrisma();
    await researched(db);
    await processGrowthProspect({
      db,
      campaignId: db.state.campaigns[0].id,
      prospectId: db.state.prospects[0].id,
      fetchFn: htmlFetch(WOO_HTML),
      chatFn: stageChat(reasonerJson(), criticJson("fail")),
    });
    assert.equal(db.state.prospects[0].lifecycleState, "rejected");
    assert.equal(db.state.critics[0].reviewState, "rejected");
  });

  it("critic needs_review → needs_review", async () => {
    const db = createFakePrisma();
    await researched(db);
    await processGrowthProspect({
      db,
      campaignId: db.state.campaigns[0].id,
      prospectId: db.state.prospects[0].id,
      fetchFn: htmlFetch(WOO_HTML),
      chatFn: stageChat(reasonerJson(), criticJson("needs_review")),
    });
    assert.equal(db.state.prospects[0].lifecycleState, "needs_review");
  });

  it("critic pass + grounded qualification → qualified", async () => {
    const db = createFakePrisma();
    await researched(db);
    await processGrowthProspect({
      db,
      campaignId: db.state.campaigns[0].id,
      prospectId: db.state.prospects[0].id,
      fetchFn: htmlFetch(WOO_HTML),
      chatFn: stageChat(reasonerJson(), criticJson("pass")),
    });
    assert.equal(db.state.prospects[0].lifecycleState, "qualified");
    assert.equal(db.state.prospects[0].latestReviewState, "accepted");
    assert.equal(db.state.prospects[0].latestQualificationDecision, "possible_fit");
  });

  it("critic pass + zero grounded LLM reasons → NOT qualified", async () => {
    const db = createFakePrisma();
    await researched(db);
    await processGrowthProspect({
      db,
      campaignId: db.state.campaigns[0].id,
      prospectId: db.state.prospects[0].id,
      fetchFn: htmlFetch(WOO_HTML),
      chatFn: stageChat(
        JSON.stringify({
          decision: "strong_fit",
          summary: "Looks like a fit without citing anything.",
          reasons: [],
          uncertainties: [],
        }),
        criticJson("pass")
      ),
    });
    assert.notEqual(db.state.prospects[0].lifecycleState, "qualified");
    assert.notEqual(db.state.prospects[0].latestReviewState, "accepted");
  });

  it("critic stage is idempotent", async () => {
    const db = createFakePrisma();
    await researched(db);
    await processGrowthProspect({
      db,
      campaignId: db.state.campaigns[0].id,
      prospectId: db.state.prospects[0].id,
      fetchFn: htmlFetch(WOO_HTML),
      chatFn: stageChat(reasonerJson(), criticJson("pass")),
    });
    const critic = db.state.jobs.find((j) => j.type === "critic");
    const count = db.state.critics.length;
    const again = await processGrowthJob({ db, jobId: critic.id, chatFn: async () => criticJson("fail") });
    assert.equal(again.status, "already_complete");
    assert.equal(db.state.critics.length, count);
    assert.equal(db.state.prospects[0].lifecycleState, "qualified");
  });

  it("latest decision/review fields update transactionally", async () => {
    const db = createFakePrisma();
    await researched(db);
    const qualify = db.state.jobs.find((j) => j.type === "qualify");
    const originalCreate = db.growthJob.create.bind(db.growthJob);
    db.growthJob.create = async (args) => {
      if (args.data?.type === "critic") throw new Error("boom_next_job");
      return originalCreate(args);
    };
    const result = await processGrowthJob({ db, jobId: qualify.id, chatFn: async () => reasonerJson() });
    assert.equal(result.status, "failed");
    assert.equal(db.state.qualifications.length, 0);
    assert.equal(db.state.prospects[0].latestQualificationDecision, null);
    assert.equal(db.state.jobs.filter((j) => j.type === "critic").length, 0);
    assert.equal(db.state.jobs.find((j) => j.id === qualify.id).status, "failed");
  });

  it("reasoner timeout produces bounded failure", async () => {
    const db = createFakePrisma();
    await researched(db);
    const qualify = db.state.jobs.find((j) => j.type === "qualify");
    const result = await processGrowthJob({
      db,
      jobId: qualify.id,
      chatFn: async () => {
        throw new AicreditsTimeoutError();
      },
    });
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, GROWTH_ERROR_CODES.QUALIFICATION_TIMEOUT);
    const msg = db.state.jobs.find((j) => j.id === qualify.id).lastErrorMessage;
    assert.ok(String(msg).length <= 300);
    assert.equal(db.state.prospects[0].lifecycleState, "qualification_pending");
  });

  it("critic timeout cannot become accepted", async () => {
    const db = createFakePrisma();
    await researched(db);
    const qualify = db.state.jobs.find((j) => j.type === "qualify");
    await processGrowthJob({ db, jobId: qualify.id, chatFn: async () => reasonerJson() });
    const critic = db.state.jobs.find((j) => j.type === "critic");
    const result = await processGrowthJob({
      db,
      jobId: critic.id,
      chatFn: async () => {
        throw new AicreditsTimeoutError();
      },
    });
    assert.equal(result.accepted, false);
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, GROWTH_ERROR_CODES.CRITIC_TIMEOUT);
    assert.equal(db.state.critics.length, 0);
    assert.equal(db.state.qualifications.length, 1);
    assert.equal(db.state.jobs.find((j) => j.id === critic.id).status, "failed");
    assert.notEqual(db.state.prospects[0].lifecycleState, "qualified");
    assert.notEqual(db.state.prospects[0].latestReviewState, "accepted");
    assert.equal(db.state.prospects[0].lifecycleState, "needs_review");
  });

  it("retries critic on the same qualification after technical timeout", async () => {
    const db = createFakePrisma();
    await researched(db);
    const qualify = db.state.jobs.find((j) => j.type === "qualify");
    await processGrowthJob({ db, jobId: qualify.id, chatFn: async () => reasonerJson() });
    const critic = db.state.jobs.find((j) => j.type === "critic");
    await processGrowthJob({
      db,
      jobId: critic.id,
      chatFn: async () => {
        throw new AicreditsTimeoutError();
      },
    });
    const retry = await db.growthJob.create({
      data: {
        campaignId: db.state.campaigns[0].id,
        prospectId: db.state.prospects[0].id,
        type: "critic",
        status: "pending",
        availableAt: new Date(),
      },
    });
    const result = await processGrowthJob({
      db,
      jobId: retry.id,
      chatFn: async () => criticJson("pass"),
    });
    assert.equal(result.status, "succeeded");
    assert.equal(db.state.qualifications.length, 1);
    assert.equal(db.state.critics.length, 1);
    assert.equal(db.state.prospects[0].lifecycleState, "qualified");
    assert.equal(db.state.prospects[0].latestReviewState, "accepted");
  });

  it("AI call budget cannot be exceeded", async () => {
    const db = createFakePrisma();
    await researched(db);
    const qualify = db.state.jobs.find((j) => j.type === "qualify");
    const budget = createGrowthAiBudget();
    budget.reasonerCalls = 1;
    budget.criticCalls = 1;
    budget.totalCalls = 2;
    const result = await processGrowthJob({
      db,
      jobId: qualify.id,
      budget,
      chatFn: async () => reasonerJson(),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, GROWTH_ERROR_CODES.QUALIFICATION_BUDGET_EXCEEDED);
  });

  it("provider secret/error body is not persisted", async () => {
    const db = createFakePrisma();
    await researched(db);
    const qualify = db.state.jobs.find((j) => j.type === "qualify");
    await processGrowthJob({
      db,
      jobId: qualify.id,
      chatFn: async () => {
        throw new Error("401 Bearer sk-live-secret123 AICREDITS_API_KEY=abc");
      },
    });
    const msg = db.state.jobs.find((j) => j.id === qualify.id).lastErrorMessage;
    assert.equal(/sk-live-secret123/.test(msg), false);
    assert.equal(/Bearer\s+sk/.test(msg), false);
    assert.equal(/AICREDITS_API_KEY=abc/.test(msg), false);
  });
});

describe("atomicity and evidence lifecycle", () => {
  it("job completion + next-job creation are atomic conceptually", async () => {
    const db = createFakePrisma();
    const c = db.seed.campaign();
    const p = db.seed.prospect(c);
    p.lifecycleState = "research_pending";
    const job = await db.seed.job(c, p, "research");
    const original = db.growthJob.create.bind(db.growthJob);
    db.growthJob.create = async (args) => {
      if (args.data?.type === "qualify") throw new Error("boom_qualify");
      return original(args);
    };
    const result = await processGrowthJob({ db, jobId: job.id, fetchFn: htmlFetch(WOO_HTML) });
    assert.equal(result.status, "failed");
    assert.equal(db.state.evidence.length, 0);
    assert.equal(db.state.jobs.filter((j) => j.type === "qualify").length, 0);
    assert.equal(db.state.jobs.find((j) => j.id === job.id).status, "failed");
  });

  it("failed job cannot accidentally enqueue downstream success stage", async () => {
    const db = createFakePrisma();
    const c = db.seed.campaign();
    const p = db.seed.prospect(c);
    p.lifecycleState = "research_pending";
    const job = await db.seed.job(c, p, "research");
    await processGrowthJob({ db, jobId: job.id, fetchFn: htmlFetch("", { failRoot: true }) });
    assert.equal(db.state.jobs.filter((j) => j.type === "qualify" || j.type === "critic").length, 0);
  });

  it("deleting an operational job no longer destroys qualification-supporting evidence", async () => {
    const db = createFakePrisma();
    const c = db.seed.campaign();
    const p = db.seed.prospect(c);
    p.lifecycleState = "research_pending";
    const job = await db.seed.job(c, p, "research");
    await processGrowthJob({ db, jobId: job.id, fetchFn: htmlFetch(WOO_HTML) });
    const before = db.state.evidence.length;
    assert.ok(before >= 1);
    await db.growthJob.delete({ where: { id: job.id } });
    assert.equal(db.state.evidence.length, before);
    assert.ok(db.state.evidence.every((e) => e.jobId == null));
    assert.ok(db.state.evidence.every((e) => e.runId === job.id));
  });
});
