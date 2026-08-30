/**
 * Phase 7 — Monetization & entitlements (mocked; no live Razorpay).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import crypto from "node:crypto";

import {
  PLAN_IDS,
  PLANS,
  getPlan,
  isUnlimited,
  resolvePlanId,
  getEntitlements,
  checkLimit,
  expectedAiTestsForAudit,
  countBillableAiTests,
  upgradePayload,
  preflightAudit,
  verifyWebhookSignature,
  mapRazorpayStatus,
  currentBillingPeriod,
  toBillingStatusView,
} from "../index.js";
import { processRazorpayWebhook } from "../webhook.js";

describe("plans & entitlements", () => {
  it("defines FREE / PRO / AGENCY with expected limits", () => {
    assert.equal(getPlan(PLAN_IDS.FREE).buyerQuestions, 5);
    assert.equal(getPlan(PLAN_IDS.FREE).monitoring, 0);
    assert.equal(getPlan(PLAN_IDS.FREE).advancedDiagnosis, false);
    assert.equal(getPlan(PLAN_IDS.PRO).buyerQuestions, 50);
    assert.equal(getPlan(PLAN_IDS.PRO).monitoring, 3);
    assert.equal(getPlan(PLAN_IDS.PRO).advancedCompetitors, true);
    assert.ok(isUnlimited(getPlan(PLAN_IDS.PRO).historicalAudits));
    assert.equal(getPlan(PLAN_IDS.AGENCY).websites, 25);
    assert.equal(getPlan(PLAN_IDS.AGENCY).teamMembers, 5);
    assert.equal(PLANS.agency.purchasable, false);
  });

  it("resolves active subscription to Pro only with provider payment proof", () => {
    const paid = {
      plan: "pro",
      status: "active",
      provider: "paddle",
      providerSubscriptionId: "sub_provider_1",
      currentPeriodEnd: new Date(Date.now() + 86400_000),
    };
    assert.equal(resolvePlanId(paid), PLAN_IDS.PRO);
    assert.equal(resolvePlanId({ plan: "pro", status: "active" }), PLAN_IDS.FREE);
    assert.equal(resolvePlanId({ plan: "pro", status: "trialing", providerSubscriptionId: "sub_1" }), PLAN_IDS.FREE);
    assert.equal(resolvePlanId({ plan: "pro", status: "expired", providerSubscriptionId: "sub_1" }), PLAN_IDS.FREE);
    assert.equal(resolvePlanId({ plan: "pro", status: "cancelled", providerSubscriptionId: "sub_1" }), PLAN_IDS.FREE);
    assert.equal(resolvePlanId({ plan: "pro", status: "past_due", providerSubscriptionId: "sub_1" }), PLAN_IDS.FREE);
  });

  it("never grants Pro from Clerk paid, email verification, or login flags", () => {
    assert.equal(resolvePlanId(null, { clerkPaid: true, emailVerified: true }), PLAN_IDS.FREE);
    assert.equal(resolvePlanId({ plan: "pro", status: "expired" }, { clerkPaid: true }), PLAN_IDS.FREE);
    assert.equal(getEntitlements(null, { clerkPaid: true }).isPaid, false);
    assert.equal(getEntitlements(null, { clerkPaid: true }).status, "none");
  });

  it("checkLimit blocks when used >= limit", () => {
    const ok = checkLimit(5, 3, "buyerQuestions");
    assert.equal(ok.ok, true);
    assert.equal(ok.remaining, 2);
    const bad = checkLimit(5, 5, "buyerQuestions");
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, "buyerQuestions_exceeded");
    assert.equal(checkLimit(null, 999).ok, true);
  });
});

describe("usage calculation", () => {
  it("expected AI tests = questions × providers", () => {
    assert.equal(expectedAiTestsForAudit({ questionCount: 50, providerCount: 3 }), 150);
    assert.equal(expectedAiTestsForAudit({ questionCount: 5 }), 15);
  });

  it("does not count failed provider calls as billable", () => {
    const n = countBillableAiTests({
      byQuestion: [
        {
          providers: [
            { ok: true, provider: "openai" },
            { ok: false, error: "timeout", provider: "perplexity" },
            { error: "fail", provider: "gemini" },
          ],
        },
      ],
    });
    assert.equal(n, 1);
  });

  it("skips providerCalled:false", () => {
    assert.equal(
      countBillableAiTests({
        results: [{ ok: true, meta: { providerCalled: false } }, { ok: true }],
      }),
      1
    );
  });
});

describe("audit preflight", () => {
  it("blocks when expected AI tests exceed remaining allowance", () => {
    const entitlements = getEntitlements(null);
    const flight = preflightAudit({
      entitlements,
      usage: { aiTests: 40 },
      questionCount: 5,
      providerCount: 3,
    });
    // Free aiTestsPerMonth=45; used 40; need 15 → fail
    assert.equal(flight.ok, false);
    assert.equal(flight.upgrade.upgrade, true);
    assert.equal(flight.response.status, 402);
  });

  it("allows audit within Free allowance", () => {
    const entitlements = getEntitlements(null);
    const flight = preflightAudit({
      entitlements,
      usage: { aiTests: 0 },
      questionCount: 5,
      providerCount: 3,
    });
    assert.equal(flight.ok, true);
    assert.equal(flight.expectedAiTests, 15);
  });

  it("returns structured upgrade payload", () => {
    const u = upgradePayload({
      planId: "free",
      feature: "buyerQuestions",
      used: 5,
      limit: 5,
    });
    assert.equal(u.upgrade, true);
    assert.equal(u.suggestedPlan, "pro");
    assert.match(u.message, /5\/5/);
  });
});

describe("subscription states & downgrade view", () => {
  it("maps razorpay statuses", () => {
    assert.equal(mapRazorpayStatus("active"), "active");
    assert.equal(mapRazorpayStatus("authenticated"), "active");
    assert.equal(mapRazorpayStatus("created"), "trialing");
    assert.equal(mapRazorpayStatus("halted"), "past_due");
    assert.equal(mapRazorpayStatus("cancelled"), "cancelled");
    assert.equal(mapRazorpayStatus("completed"), "expired");
  });

  it("downgrade keeps Free entitlements without deleting data concept", () => {
    const e = getEntitlements({ plan: "pro", status: "expired" });
    assert.equal(e.planId, PLAN_IDS.FREE);
    assert.equal(e.isPaid, false);
    assert.equal(e.entitlements.monitoring, 0);
    // historical data retention is a product rule — entitlements only restrict new usage
    assert.equal(e.entitlements.historicalAudits, 3);
  });

  it("toBillingStatusView hides secrets", () => {
    const view = toBillingStatusView({
      entitlements: getEntitlements({
        plan: "pro",
        status: "active",
        provider: "paddle",
        providerSubscriptionId: "sub_provider_1",
        currentPeriodEnd: new Date(Date.now() + 86400_000),
      }),
      usage: { aiTests: 1240, audits: 10, monitoringRuns: 2 },
      websiteCount: 2,
      monitoringCount: 2,
    });
    assert.equal(view.plan, "pro");
    assert.equal(view.usage.aiTests.used, 1240);
    assert.equal(view.usage.aiTests.limit, 3000);
    assert.equal(view.usage.websites.used, 2);
    assert.ok(!("keySecret" in view));
    assert.ok(!("webhookSecret" in view));
  });
});

describe("webhook security & idempotency", () => {
  it("rejects invalid webhook signature", () => {
    const body = JSON.stringify({ event: "subscription.activated" });
    const secret = "whsec_test";
    const bad = verifyWebhookSignature(body, "deadbeef", secret);
    assert.equal(bad, false);
    const goodSig = crypto.createHmac("sha256", secret).update(body).digest("hex");
    assert.equal(verifyWebhookSignature(body, goodSig, secret), true);
  });

  it("retired Razorpay webhook cannot grant Pro", async () => {
    const result = await processRazorpayWebhook(null, {
      eventId: "evt_1",
      event: "subscription.activated",
      payload: {},
    });
    assert.equal(result.granted, false);
    assert.equal(result.action, "retired");
    assert.equal(result.processed, false);
  });
});

describe("billing period helper", () => {
  it("returns UTC month bounds", () => {
    const { periodStart, periodEnd } = currentBillingPeriod(new Date("2026-08-15T12:00:00Z"));
    assert.equal(periodStart.toISOString(), "2026-08-01T00:00:00.000Z");
    assert.equal(periodEnd.toISOString(), "2026-09-01T00:00:00.000Z");
  });
});

describe("ownership-related upgrade response shape", () => {
  it("upgrade payload never trusts client plan amount fields", () => {
    const u = upgradePayload({ planId: "free", feature: "monitoring", used: 0, limit: 0 });
    assert.equal(u.code, "ENTITLEMENT_REQUIRED");
    assert.ok(!("amount" in u));
    assert.ok(!("price" in u));
  });
});
