import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildMonitoringAlerts,
  ALERT_THRESHOLDS,
  ALERT_TYPES,
  isValidFrequency,
  weeklyScheduleKey,
  monthlyScheduleKey,
  scheduleKeyFor,
  computeNextRunAt,
  isDue,
  allProvidersFailed,
  buildWeeklyReportData,
} from "../index.js";

describe("monitoring schedule", () => {
  it("validates frequency", () => {
    assert.equal(isValidFrequency("weekly"), true);
    assert.equal(isValidFrequency("monthly"), true);
    assert.equal(isValidFrequency("daily"), false);
  });

  it("builds weekly and monthly schedule keys", () => {
    const d = new Date("2026-08-13T12:00:00Z");
    assert.match(weeklyScheduleKey(d), /^\d{4}-W\d{2}$/);
    assert.equal(monthlyScheduleKey(d), "2026-08");
    assert.equal(scheduleKeyFor("monthly", d), "2026-08");
  });

  it("computes next run and due checks", () => {
    const from = new Date("2026-08-01T00:00:00Z");
    const nextW = computeNextRunAt("weekly", from);
    assert.ok(nextW.getTime() > from.getTime());
    const nextM = computeNextRunAt("monthly", from);
    assert.ok(nextM.getTime() - from.getTime() >= 29 * 86400000);

    assert.equal(isDue({ active: true, nextRunAt: new Date("2020-01-01") }, new Date()), true);
    assert.equal(isDue({ active: false, nextRunAt: new Date("2020-01-01") }, new Date()), false);
    assert.equal(isDue({ active: true, nextRunAt: new Date("2099-01-01") }, new Date()), false);
  });
});

describe("alert thresholds", () => {
  const previous = {
    mentionShare: 50,
    recommendationShare: 40,
    overallScore: 55,
    providerMetrics: {
      openai: { recommendationShare: 50, tests: 2 },
      perplexity: { recommendationShare: 45, tests: 2 },
      gemini: { recommendationShare: 40, tests: 2 },
    },
    competitors: [{ name: "Kind", recommendationShare: 30 }],
    perception: { missingThemes: ["organic"] },
  };

  it("emits visibility drop and provider drop", () => {
    const current = {
      id: "a2",
      mentionShare: previous.mentionShare - ALERT_THRESHOLDS.visibilityDropPp,
      recommendationShare: 20,
      overallScore: 40,
      providerMetrics: {
        openai: { recommendationShare: 35, tests: 2 },
        perplexity: { recommendationShare: 45, tests: 2 },
        gemini: { recommendationShare: 40, tests: 2 },
      },
      competitors: [{ name: "Kind", recommendationShare: 55 }],
      perception: { missingThemes: ["organic", "protein"] },
    };
    const alerts = buildMonitoringAlerts({
      current,
      previous,
      websiteId: "w1",
      auditId: "a2",
      monitoringId: "m1",
    });
    assert.ok(alerts.some((a) => a.type === ALERT_TYPES.VISIBILITY_DROP));
    assert.ok(alerts.some((a) => a.type === ALERT_TYPES.PROVIDER_DROP && a.data.provider === "openai"));
    assert.ok(alerts.some((a) => a.type === ALERT_TYPES.COMPETITOR_OVERTAKE));
    assert.ok(alerts.some((a) => a.type === ALERT_TYPES.SCORE_CHANGE));
    assert.ok(alerts.some((a) => a.type === ALERT_TYPES.PERCEPTION_CHANGE));
  });

  it("excludes failed providers from provider-drop alerts", () => {
    const current = {
      mentionShare: 50,
      recommendationShare: 40,
      overallScore: 55,
      providerMetrics: {
        openai: { recommendationShare: 50, tests: 2 },
        perplexity: { recommendationShare: 0, tests: 0 },
        gemini: { recommendationShare: 40, tests: 2 },
      },
      competitors: [],
    };
    const prev = {
      ...previous,
      providerMetrics: {
        openai: { recommendationShare: 50, tests: 2 },
        perplexity: { recommendationShare: 60, tests: 2 },
        gemini: { recommendationShare: 40, tests: 2 },
      },
    };
    const alerts = buildMonitoringAlerts({ current, previous: prev, websiteId: "w" });
    assert.ok(!alerts.some((a) => a.type === ALERT_TYPES.PROVIDER_DROP && a.data?.provider === "perplexity"));
  });

  it("detects new competitor", () => {
    const alerts = buildMonitoringAlerts({
      current: {
        mentionShare: 40,
        recommendationShare: 40,
        overallScore: 50,
        providerMetrics: {},
        competitors: [{ name: "RXBAR", recommendationShare: 25 }],
      },
      previous: {
        mentionShare: 40,
        recommendationShare: 40,
        overallScore: 50,
        providerMetrics: {},
        competitors: [],
      },
      websiteId: "w",
    });
    assert.ok(alerts.some((a) => a.type === ALERT_TYPES.NEW_COMPETITOR));
  });
});

describe("all-provider failure + report", () => {
  it("detects all providers failed", () => {
    assert.equal(
      allProvidersFailed([
        {
          providers: [
            { provider: "openai", error: "x" },
            { provider: "perplexity", error: "y" },
            { provider: "gemini", error: "z" },
          ],
        },
      ]),
      true
    );
    assert.equal(
      allProvidersFailed([
        {
          providers: [
            { provider: "openai", error: null },
            { provider: "gemini", error: "z" },
          ],
        },
      ]),
      false
    );
  });

  it("builds weekly report data shape", () => {
    const report = buildWeeklyReportData({
      website: { id: "w", domain: "a.com", brandName: "A", url: "https://a.com" },
      currentAudit: { id: "c", mentionShare: 50, recommendationShare: 40, top3Share: 20, overallScore: 55, completedAt: new Date() },
      previousAudit: { id: "p", mentionShare: 40, recommendationShare: 30, top3Share: 10, overallScore: 45, completedAt: new Date() },
      alerts: [{ type: "visibility_rise", severity: "info", title: "Up" }],
      issues: [{ id: "x", priority: "high", title: "Fix me" }],
    });
    assert.equal(report.website.domain, "a.com");
    assert.ok(report.providerMovement.openai);
    assert.equal(report.recommendedActions[0].id, "x");
  });
});

describe("idempotency claim helper (fake db)", () => {
  it("claims only once per schedule key", async () => {
    const { claimMonitoringRun } = await import("../run.js");
    const state = { lastScheduleKey: null, lastStatus: "completed" };
    const db = {
      monitoring: {
        async updateMany({ where, data }) {
          const and = where.AND || [];
          const notKey = and.find((c) => c.NOT?.lastScheduleKey != null)?.NOT?.lastScheduleKey;
          if (notKey != null && state.lastScheduleKey === notKey) return { count: 0 };
          if (state.lastStatus === "running") return { count: 0 };
          state.lastScheduleKey = data.lastScheduleKey;
          state.lastStatus = data.lastStatus;
          return { count: 1 };
        },
        async findUnique() {
          return {
            id: "m1",
            lastScheduleKey: state.lastScheduleKey,
            lastStatus: state.lastStatus,
            lastRunAt: new Date(),
          };
        },
      },
    };
    const m = { id: "m1" };
    assert.equal(await claimMonitoringRun(db, m, "2026-W33"), true);
    state.lastStatus = "completed"; // finished first run but same schedule key
    assert.equal(await claimMonitoringRun(db, m, "2026-W33"), false);
  });
});
