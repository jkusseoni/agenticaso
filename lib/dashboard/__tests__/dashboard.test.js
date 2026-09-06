import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDashboardView,
  buildTrendSeries,
  buildProviderCards,
  buildCompetitorView,
  buildActionList,
  applyPlanGates,
} from "../transform.js";

const sampleAudit = {
  id: "a1",
  websiteId: "w1",
  status: "completed",
  completedAt: "2026-08-10T10:00:00.000Z",
  mentionShare: 40,
  recommendationShare: 20,
  top3Share: 10,
  overallScore: 48,
  overallStatus: "ok",
  providerMetrics: {
    openai: { mentionShare: 50, recommendationShare: 30, top3Share: 20, tests: 2 },
    perplexity: { mentionShare: 40, recommendationShare: 20, top3Share: 10, tests: 2 },
    gemini: { mentionShare: 0, recommendationShare: 0, top3Share: 0, tests: 0 },
  },
  agenticScore: {
    found: { score: null, status: "not_evaluated" },
    understood: { score: 42, status: "ok" },
    recommended: { score: 28, status: "ok" },
    bought: { score: null, status: "not_evaluated" },
    overall: { score: 48, status: "ok" },
  },
  website: { id: "w1", domain: "acmefoods.com", brandName: "Acme Foods", url: "https://acmefoods.com" },
  competitors: [
    { name: "Kind", recommendationShare: 55, top3Share: 60, mentions: 4, averagePosition: 1.5 },
    { name: "RXBAR", recommendationShare: 35, top3Share: 30, mentions: 2, averagePosition: 2.5 },
  ],
  perception: {
    brandThemes: ["organic"],
    aiThemes: ["organic", "protein"],
    missingThemes: ["organic"],
    unexpectedThemes: ["protein"],
    method: "deterministic_keywords",
  },
  intelligenceSummary: {
    competitorGap: { targetShare: 20, competitorShare: 55, gap: -35, competitorName: "Kind" },
  },
  aiTests: [
    { provider: "openai", error: null },
    { provider: "perplexity", error: null },
    { provider: "gemini", error: "Missing GEMINI_API_KEY" },
  ],
  questions: [
    { id: "q1", question: "best organic snacks", category: "discovery" },
    { id: "q2", question: "where to buy protein bars", category: "purchase" },
  ],
};

describe("dashboard transform", () => {
  it("builds ready view with KPIs and providers", () => {
    const view = buildDashboardView({ audit: sampleAudit, auditList: [sampleAudit], isPaid: true });
    assert.equal(view.state, "ready");
    assert.equal(view.hero.score, 48);
    assert.equal(view.kpis.mentionShare.value, 40);
    assert.equal(view.providers.length, 3);
    assert.equal(view.providers.find((p) => p.id === "gemini").failed, true);
  });

  it("handles missing previous audit / empty trend", () => {
    const trend = buildTrendSeries([sampleAudit]);
    assert.equal(trend.available, false);
    assert.match(trend.message, /another audit/i);

    const view = buildDashboardView({ audit: sampleAudit, auditList: [sampleAudit], isPaid: true });
    assert.equal(view.whatChanged.available, false);
  });

  it("builds trend when multiple audits exist", () => {
    const list = [
      { ...sampleAudit, id: "a2", completedAt: "2026-08-12T10:00:00.000Z", overallScore: 55, mentionShare: 50, recommendationShare: 30 },
      sampleAudit,
    ];
    const trend = buildTrendSeries(list);
    assert.equal(trend.available, true);
    assert.equal(trend.points.length, 2);
    assert.equal(trend.points[0].id, "a1");
  });

  it("does not fail dashboard when a provider failed", () => {
    const cards = buildProviderCards(sampleAudit, null);
    assert.ok(cards.every((c) => c.label));
    assert.equal(cards.find((c) => c.id === "openai").failed, false);
    assert.equal(cards.find((c) => c.id === "gemini").failed, true);
  });

  it("builds competitor rows with evidence-only why ahead", () => {
    const view = buildCompetitorView(sampleAudit, null);
    assert.equal(view.rows[0].isTarget, true);
    assert.ok(view.rows.some((r) => r.name === "Kind"));
    const kind = view.rows.find((r) => r.name === "Kind");
    assert.ok(kind.whyAhead.length >= 1);
    assert.ok(kind.gap < 0);
  });

  it("builds actions only from detected gaps", () => {
    const actions = buildActionList(sampleAudit);
    assert.ok(actions.some((a) => /comparison|gap|Kind|recommend/i.test(a.title + a.detail)));
    assert.ok(actions.every((a) => a.evidence));
  });

  it("applies free/pro gating", () => {
    const pro = buildDashboardView({ audit: sampleAudit, auditList: [sampleAudit], isPaid: true });
    const free = buildDashboardView({ audit: sampleAudit, auditList: [sampleAudit], isPaid: false });
    assert.equal(pro.plan, "pro");
    assert.equal(free.plan, "free");
    assert.equal(free.gates.trends, false);
    assert.equal(pro.gates.trends, true);
    assert.ok(free.providers.some((p) => p.locked));
    assert.ok(!pro.providers.some((p) => p.locked));
    assert.ok(free.perception.locked);
    assert.ok(free.actions.length <= 2);
  });

  it("returns empty and db unavailable states", () => {
    const empty = buildDashboardView({ audit: null, auditList: [], isPaid: false });
    assert.equal(empty.state, "empty");
    const db = buildDashboardView({ dbStatus: "unavailable", isPaid: false });
    assert.equal(db.state, "db_unavailable");
  });

  it("applyPlanGates is idempotent-safe for free", () => {
    const base = buildDashboardView({ audit: sampleAudit, auditList: [sampleAudit], isPaid: true });
    const gated = applyPlanGates(base, false);
    assert.equal(gated.plan, "free");
    assert.equal(gated.trend.locked, true);
  });
});
