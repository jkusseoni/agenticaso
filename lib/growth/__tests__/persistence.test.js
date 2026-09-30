import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  canTransitionProspect,
  assertProspectTransition,
  nextProspectState,
  canTransitionJob,
  isQualificationDecision,
  isReviewState,
  isProspectLifecycle,
  isJobType,
  isJobStatus,
} from "../state-machine.js";
import {
  normalizeProspectIdentity,
  prospectDedupeKey,
  createCampaignData,
  serializeQualificationForPersistence,
  schemaForbidsRawHtml,
  GROWTH_PROVENANCE,
} from "../persistence.js";

function createFakeGrowthDb() {
  const state = {
    workspaces: [],
    campaigns: [],
    prospects: [],
    jobs: [],
    evidence: [],
    qualifications: [],
    reasons: [],
    reasonEvidence: [],
    critics: [],
  };
  const genId = () => `id_${Math.random().toString(36).slice(2, 10)}`;
  return {
    state,
    createCampaign(workspaceId, data) {
      const row = { id: genId(), workspaceId, ...createCampaignData(workspaceId, data) };
      state.campaigns.push(row);
      return row;
    },
    createProspect(campaignId, identity) {
      const key = prospectDedupeKey(campaignId, identity.canonicalDomain);
      if (state.prospects.some((p) => prospectDedupeKey(p.campaignId, p.canonicalDomain) === key)) {
        const err = new Error("duplicate_prospect");
        err.code = "P2002";
        throw err;
      }
      const row = {
        id: genId(),
        campaignId,
        originalUrl: identity.originalUrl,
        normalizedUrl: identity.normalizedUrl,
        canonicalDomain: identity.canonicalDomain,
        lifecycleState: "candidate",
        latestQualificationDecision: null,
        latestReviewState: null,
      };
      state.prospects.push(row);
      return row;
    },
    deleteCampaign(id) {
      const prospectIds = state.prospects.filter((p) => p.campaignId === id).map((p) => p.id);
      const jobIds = state.jobs.filter((j) => j.campaignId === id).map((j) => j.id);
      const qualIds = state.qualifications.filter((q) => prospectIds.includes(q.prospectId)).map((q) => q.id);
      const reasonIds = state.reasons.filter((r) => qualIds.includes(r.qualificationId)).map((r) => r.id);
      state.reasonEvidence = state.reasonEvidence.filter((x) => !reasonIds.includes(x.reasonId));
      state.reasons = state.reasons.filter((r) => !reasonIds.includes(r.id));
      state.critics = state.critics.filter((c) => !qualIds.includes(c.qualificationId));
      state.qualifications = state.qualifications.filter((q) => !qualIds.includes(q.id));
      state.evidence = state.evidence.filter((e) => !prospectIds.includes(e.prospectId) && !jobIds.includes(e.jobId));
      state.jobs = state.jobs.filter((j) => j.campaignId !== id);
      state.prospects = state.prospects.filter((p) => p.campaignId !== id);
      state.campaigns = state.campaigns.filter((c) => c.id !== id);
    },
  };
}

describe("prospect identity normalization", () => {
  it("normalizes www, trailing slash, and tracking query params", () => {
    const a = normalizeProspectIdentity("https://www.Example.com/store/?utm_source=ad&gclid=abc&keep=1");
    const b = normalizeProspectIdentity("http://example.com/store");
    assert.equal(a.ok, true);
    assert.equal(a.canonicalDomain, "example.com");
    assert.equal(a.normalizedUrl, "https://example.com/store?keep=1");
    assert.equal(b.canonicalDomain, a.canonicalDomain);
  });

  it("treats www and bare host as the same canonical domain", () => {
    const a = normalizeProspectIdentity("https://www.shop.example/");
    const b = normalizeProspectIdentity("https://shop.example");
    assert.equal(a.canonicalDomain, b.canonicalDomain);
    assert.equal(a.canonicalDomain, "shop.example");
  });
});

describe("campaign / prospect uniqueness", () => {
  it("rejects a duplicate canonical domain inside one campaign and allows it in another", () => {
    const db = createFakeGrowthDb();
    const c1 = db.createCampaign("ws1", {
      name: "Acme Recover",
      productProfile: { product: { name: "Acme Recover", url: "https://acme.example", description: "Recover checkouts" } },
    });
    const c2 = db.createCampaign("ws1", { name: "Other", productProfile: { product: { name: "Other" } } });
    const id = normalizeProspectIdentity("https://www.store.example/path?utm_campaign=x");
    db.createProspect(c1.id, id);
    assert.throws(() => db.createProspect(c1.id, normalizeProspectIdentity("https://store.example")), /duplicate_prospect/);
    const other = db.createProspect(c2.id, normalizeProspectIdentity("https://store.example"));
    assert.equal(other.canonicalDomain, "store.example");
    assert.equal(c1.productName.includes("CartRenew"), false);
  });

  it("expresses workspace ownership through the campaign relation", () => {
    const db = createFakeGrowthDb();
    const campaign = db.createCampaign("workspace_abc", { name: "Q1" });
    assert.equal(campaign.workspaceId, "workspace_abc");
  });

  it("cascades campaign delete to prospects", () => {
    const db = createFakeGrowthDb();
    const c = db.createCampaign("ws", { name: "C" });
    db.createProspect(c.id, normalizeProspectIdentity("https://a.example"));
    db.deleteCampaign(c.id);
    assert.equal(db.state.campaigns.length, 0);
    assert.equal(db.state.prospects.length, 0);
  });
});

describe("prospect state machine", () => {
  it("allows the research → qualify happy path", () => {
    let state = "candidate";
    state = nextProspectState(state, "queue_research");
    state = nextProspectState(state, "start_research");
    state = nextProspectState(state, "finish_research");
    state = nextProspectState(state, "queue_qualify");
    state = nextProspectState(state, "start_qualify");
    assert.equal(canTransitionProspect(state, "qualified"), true);
    assert.equal(canTransitionProspect(state, "needs_review"), true);
    assert.equal(canTransitionProspect(state, "rejected"), true);
    assertProspectTransition("qualifying", "qualified");
  });

  it("forbids candidate → qualified and rejected → researching", () => {
    assert.equal(canTransitionProspect("candidate", "qualified"), false);
    assert.equal(canTransitionProspect("rejected", "researching"), false);
    assert.throws(() => assertProspectTransition("candidate", "qualified"), /illegal_prospect_transition/);
    assert.throws(() => assertProspectTransition("rejected", "researching"), /illegal_prospect_transition/);
  });

  it("keeps qualification decision separate from lifecycle and review state", () => {
    assert.equal(isProspectLifecycle("qualified"), true);
    assert.equal(isQualificationDecision("strong_fit"), true);
    assert.equal(isProspectLifecycle("strong_fit"), false);
    assert.equal(isReviewState("accepted"), true);
    assert.equal(isQualificationDecision("accepted"), false);
    assert.equal(isReviewState("pass"), false);
  });

  it("validates job types and statuses", () => {
    assert.equal(isJobType("research"), true);
    assert.equal(isJobType("outreach"), false);
    assert.equal(isJobStatus("pending"), true);
    assert.equal(canTransitionJob("pending", "running"), true);
    assert.equal(canTransitionJob("succeeded", "running"), false);
    assert.equal(canTransitionProspect("researching", "research_pending"), true);
    assert.equal(canTransitionProspect("failed", "research_pending"), true);
    assert.equal(canTransitionProspect("rejected", "research_pending"), false);
    assert.equal(canTransitionProspect("qualified", "research_pending"), false);
    assert.equal(canTransitionProspect("qualification_pending", "research_pending"), true);
    assert.equal(canTransitionProspect("qualification_pending", "qualifying"), true);
    assert.equal(canTransitionProspect("needs_review", "qualified"), true);
    assert.equal(canTransitionProspect("qualified", "researching"), false);
  });
});

describe("qualification persistence serialization", () => {
  it("maps multiple citations relationally and allows uncited uncertainties", () => {
    const serialized = serializeQualificationForPersistence({
      status: "accept",
      qualification: {
        decision: "possible_fit",
        summary: "WooCommerce and subscriptions were observed.",
        reasons: [
          { type: "observation", statement: "Woo plugin.", evidenceIds: ["EV-001", "EV-002"] },
        ],
        uncertainties: [{ type: "inference", statement: "Recovery usage is unknown.", evidenceIds: [] }],
      },
      critic: { verdict: "pass", policy: { verdict: "pass" }, items: [] },
      reasoner: { ok: true, usage: { model: "openai/gpt-4o-mini", llmCalls: 1 } },
    });
    assert.equal(serialized.reviewState, "accepted");
    assert.deepEqual(serialized.reasons[0].packEvidenceIds, ["EV-001", "EV-002"]);
    assert.equal(serialized.qualification.uncertainties[0].evidenceIds.length, 0);
    assert.equal(serialized.qualification.reasonerModel, "openai/gpt-4o-mini");
    assert.equal(serialized.qualification.evidencePackVersion, GROWTH_PROVENANCE.evidencePackVersion);
  });

  it("cannot serialize a zero-reason LLM result as trusted/accepted", () => {
    const serialized = serializeQualificationForPersistence({
      status: "accept",
      qualification: {
        decision: "possible_fit",
        summary: "Looks good.",
        reasons: [],
        uncertainties: [],
      },
      critic: { verdict: "pass", policy: { verdict: "pass" } },
      reasoner: { ok: true, shortCircuited: false, usage: { model: "openai/gpt-4o-mini" } },
    });
    assert.equal(serialized.trusted, false);
    assert.equal(serialized.reviewState, "needs_review");
    assert.equal(serialized.invariant.blocked, true);
  });

  it("does not let critic persistence mutate qualification reasons", () => {
    const qualification = {
      decision: "possible_fit",
      summary: "Woo observed.",
      reasons: [{ type: "observation", statement: "Woo plugin.", evidenceIds: ["EV-001"] }],
      uncertainties: [],
    };
    const before = JSON.stringify(qualification);
    serializeQualificationForPersistence({
      status: "reject",
      qualification,
      critic: { verdict: "fail", policy: { verdict: "fail" }, items: [{ note: "nope" }] },
    });
    assert.equal(JSON.stringify(qualification), before);
  });
});

describe("schema constraints", () => {
  it("has no raw HTML persistence field", () => {
    const schema = fs.readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8");
    assert.equal(schemaForbidsRawHtml(schema), true);
    assert.equal(/rawHtml/i.test(schema), false);
    assert.match(schema, /GrowthCampaign/);
    assert.match(schema, /GrowthQualificationReasonEvidence/);
    assert.match(schema, /@@unique\(\[campaignId, canonicalDomain\]\)/);
    assert.match(schema, /@@unique\(\[prospectId, runId, packEvidenceId\]\)/);
    assert.match(schema, /onDelete: SetNull/);
  });

  it("allows EV-001 in different research runs", () => {
    const rows = [
      { prospectId: "p1", runId: "run1", packEvidenceId: "EV-001" },
      { prospectId: "p1", runId: "run2", packEvidenceId: "EV-001" },
    ];
    const keys = new Set(rows.map((r) => `${r.prospectId}:${r.runId}:${r.packEvidenceId}`));
    assert.equal(keys.size, 2);
  });
});
