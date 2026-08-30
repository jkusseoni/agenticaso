/**
 * Regression: email/login must never activate Pro.
 * Pro requires a verified provider payment/subscription.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";

import {
  PLAN_IDS,
  DEFAULT_PRO_PRICE_LABEL,
  DEFAULT_PRO_MONTHLY_DISPLAY,
  DEFAULT_PRO_MONTHLY_CENTS,
  formatPlanPriceLabel,
  resolvePlanId,
  getEntitlements,
  hasVerifiedPaidEntitlement,
  toBillingStatusView,
} from "../index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function verifiedPayment(overrides = {}) {
  return {
    plan: PLAN_IDS.PRO,
    status: "active",
    provider: "paddle",
    providerSubscriptionId: "sub_verified_payment",
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    ...overrides,
  };
}

const BILLING_UI_FILES = [
  "app/billing/page.js",
  "app/pricing/page.js",
  "app/dashboard/page.js",
  "components/agentic/billing-usage-card.js",
];

describe("email verification and login never grant Pro", () => {
  it("email verification alone → Free", () => {
    const e = getEntitlements(null, { clerkPaid: true, emailVerified: true });
    assert.equal(e.planId, PLAN_IDS.FREE);
    assert.equal(e.isPaid, false);
    assert.notEqual(e.status, "active");
    assert.equal(e.planName, "Free");
  });

  it("login alone → Free", () => {
    const e = getEntitlements(null, { clerkPaid: false, emailVerified: false });
    assert.equal(e.planId, PLAN_IDS.FREE);
    assert.equal(e.isPaid, false);
    assert.equal(e.status, "none");
  });

  it("Clerk publicMetadata.paid without a subscription stays Free (the login bug)", () => {
    assert.equal(resolvePlanId(null, { clerkPaid: true }), PLAN_IDS.FREE);
    assert.equal(hasVerifiedPaidEntitlement(null, { clerkPaid: true }), false);
    const view = toBillingStatusView({
      entitlements: getEntitlements(null, { clerkPaid: true }),
      usage: { aiTests: 0, audits: 0 },
    });
    assert.equal(view.isPaid, false);
    assert.equal(view.plan, PLAN_IDS.FREE);
    assert.notEqual(String(view.status).toLowerCase(), "active");
  });
});

describe("payment / subscription is the only Pro source", () => {
  it("no payment/subscription → Free", () => {
    assert.equal(getEntitlements(null).isPaid, false);
    assert.equal(getEntitlements({ plan: "pro", status: "active" }).isPaid, false);
    assert.equal(
      getEntitlements({ plan: "pro", status: "trialing", providerSubscriptionId: "sub_unpaid" }).isPaid,
      false
    );
  });

  it("successful verified payment → Pro", () => {
    const e = getEntitlements(verifiedPayment());
    assert.equal(e.isPaid, true);
    assert.equal(e.planId, PLAN_IDS.PRO);
    assert.equal(e.status, "active");
    assert.equal(hasVerifiedPaidEntitlement(verifiedPayment()), true);
  });

  it("failed payment → not Pro", () => {
    const failed = [
      verifiedPayment({ status: "past_due", currentPeriodEnd: new Date(Date.now() - 86_400_000) }),
      verifiedPayment({ status: "expired" }),
      verifiedPayment({ status: "halted" }),
      { plan: "pro", status: "failed", providerSubscriptionId: "sub_fail" },
    ];
    for (const sub of failed) {
      const e = getEntitlements(sub);
      assert.equal(e.isPaid, false, `expected Free for status=${sub.status}`);
      assert.equal(e.planId, PLAN_IDS.FREE);
    }
  });

  it("cancelled payment → not Pro", () => {
    const cancelledUnpaid = getEntitlements(
      verifiedPayment({ status: "cancelled", currentPeriodEnd: null })
    );
    assert.equal(cancelledUnpaid.isPaid, false);

    const cancelledPastEnd = getEntitlements(
      verifiedPayment({
        status: "cancelled",
        currentPeriodEnd: new Date(Date.now() - 86_400_000),
      })
    );
    assert.equal(cancelledPastEnd.isPaid, false);
  });
});

describe("current billing UI copy", () => {
  it("old Razorpay references are not shown in the current billing UI", () => {
    for (const rel of BILLING_UI_FILES) {
      const text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
      assert.ok(!/Razorpay/i.test(text), `${rel} still mentions Razorpay`);
      assert.ok(!text.includes("₹1,499"), `${rel} still mentions ₹1,499`);
    }
  });

  it("current Pro price displays as $19/month", () => {
    assert.equal(DEFAULT_PRO_MONTHLY_DISPLAY, "19");
    assert.equal(DEFAULT_PRO_MONTHLY_CENTS, 1900);
    assert.equal(DEFAULT_PRO_PRICE_LABEL, "$19/month");
    assert.equal(formatPlanPriceLabel(), "$19/month");

    const pricing = fs.readFileSync(path.join(repoRoot, "app/pricing/page.js"), "utf8");
    assert.ok(pricing.includes("$19/month") || pricing.includes("DEFAULT_PRO_PRICE_LABEL"));
    const billing = fs.readFileSync(path.join(repoRoot, "app/billing/page.js"), "utf8");
    assert.ok(!billing.includes("₹1,499"));
  });
});
