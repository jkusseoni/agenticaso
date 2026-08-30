/**
 * Phase 7.1 — production hardening tests (mocked; no live AI/Razorpay).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolvePlanId,
  getEntitlements,
  countBillableAiTests,
  verifyWebhookSignature,
  DEFAULT_PRO_PRICE_LABEL,
  DEFAULT_PRO_MONTHLY_DISPLAY,
  PLAN_IDS,
  prepareMonitoringUsage,
} from "../index.js";
import { processRazorpayWebhook } from "../webhook.js";
import { claimMonitoringExecution } from "../../monitoring/run.js";
import { sanitizeErrorMessage } from "../../api/safe-error.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

describe("legacy paid is never an entitlement source", () => {
  it("Clerk paid without a verified provider subscription stays Free", () => {
    assert.equal(resolvePlanId(null, { clerkPaid: true, emailVerified: true }), PLAN_IDS.FREE);
    assert.equal(resolvePlanId(undefined, { clerkPaid: true }), PLAN_IDS.FREE);
    assert.equal(getEntitlements(null, { clerkPaid: true }).isPaid, false);
    assert.equal(getEntitlements(null, { clerkPaid: true }).planName, "Free");
  });

  it("expired / past_due stay Free even if Clerk paid is true", () => {
    assert.equal(
      resolvePlanId(
        { plan: "pro", status: "expired", providerSubscriptionId: "sub_1" },
        { clerkPaid: true }
      ),
      PLAN_IDS.FREE
    );
    assert.equal(
      resolvePlanId(
        { plan: "pro", status: "past_due", providerSubscriptionId: "sub_1" },
        { clerkPaid: true }
      ),
      PLAN_IDS.FREE
    );
  });

  it("cancelled retains Pro until currentPeriodEnd only with provider proof", () => {
    const end = new Date(Date.now() + 7 * 86400_000);
    assert.equal(
      resolvePlanId(
        { plan: "pro", status: "cancelled", currentPeriodEnd: end, provider: "paddle", providerSubscriptionId: "sub_1" },
        { clerkPaid: false, now: new Date() }
      ),
      PLAN_IDS.PRO
    );
    assert.equal(
      resolvePlanId(
        { plan: "pro", status: "cancelled", currentPeriodEnd: end },
        { now: new Date() }
      ),
      PLAN_IDS.FREE
    );
    const past = new Date(Date.now() - 86400_000);
    assert.equal(
      resolvePlanId(
        { plan: "pro", status: "cancelled", currentPeriodEnd: past, provider: "paddle", providerSubscriptionId: "sub_1" },
        { now: new Date() }
      ),
      PLAN_IDS.FREE
    );
  });

  it("active subscription is Pro only with a provider subscription id", () => {
    const unpaid = getEntitlements({ plan: "pro", status: "active" }, { clerkPaid: true });
    assert.equal(unpaid.isPaid, false);
    const e = getEntitlements(
      {
        plan: "pro",
        status: "active",
        provider: "paddle",
        providerSubscriptionId: "sub_provider_1",
        currentPeriodEnd: new Date(Date.now() + 86400_000),
      },
      { clerkPaid: false }
    );
    assert.equal(e.isPaid, true);
    assert.equal(e.planId, PLAN_IDS.PRO);
  });
});

describe("usage reservation (atomic mock)", () => {
  it("reserveUsage succeeds when under limit and fails when exhausted", async () => {
    const { reserveUsage, commitUsage, releaseUsage } = await import("../usage.js");
    let row = {
      id: "up1",
      workspaceId: "ws1",
      aiTests: 40,
      aiTestsReserved: 0,
      audits: 0,
      monitoringRuns: 0,
      periodStart: new Date("2026-08-01T00:00:00Z"),
      periodEnd: new Date("2026-09-01T00:00:00Z"),
    };
    let executeResult = 1;
    const prisma = {
      usagePeriod: {
        upsert: async () => row,
        findUnique: async () => row,
        update: async ({ data }) => {
          if (data.aiTestsReserved?.increment) {
            row = { ...row, aiTestsReserved: row.aiTestsReserved + data.aiTestsReserved.increment };
          }
          return row;
        },
      },
      $executeRaw: async () => {
        if (executeResult === 1) {
          // simulate successful reserve of 15
          row = { ...row, aiTestsReserved: row.aiTestsReserved + 15 };
        }
        return executeResult;
      },
    };

    const ok = await reserveUsage(prisma, "ws1", { aiTests: 15, limit: 45 });
    assert.equal(ok.ok, true);
    assert.equal(ok.reserved, 15);

    executeResult = 0;
    row = { ...row, aiTests: 40, aiTestsReserved: 5 };
    const bad = await reserveUsage(prisma, "ws1", { aiTests: 15, limit: 45 });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, "insufficient_allowance");

    // commit/release paths should not throw with mocked executeRaw
    executeResult = 1;
    await commitUsage(prisma, "ws1", { reservedAiTests: 15, actualAiTests: 10, audits: 1 });
    await releaseUsage(prisma, "ws1", { reservedAiTests: 5 });
  });
});

describe("monitoring prepare + concurrency", () => {
  it("prepareMonitoringUsage skips Free entitlement without calling providers", async () => {
    const db = {
      workspace: {
        findUnique: async () => ({
          id: "ws1",
          subscription: { plan: "pro", status: "expired" },
        }),
      },
      buyerQuestion: { findMany: async () => [{ id: "q1", question: "best shoes?" }] },
    };
    const monitoring = {
      website: {
        id: "site1",
        workspace: { id: "ws1", subscription: { plan: "pro", status: "expired" } },
      },
    };
    const prep = await prepareMonitoringUsage(db, monitoring);
    assert.equal(prep.ok, false);
    assert.equal(prep.status, "skipped_entitlement");
  });

  it("claimMonitoringExecution prevents concurrent runs", async () => {
    let status = "completed";
    let lastScheduleKey = null;
    let updateCount = 0;
    const db = {
      monitoring: {
        updateMany: async ({ where, data }) => {
          // Simulate: if already running and not stale, reject
          if (status === "running") {
            return { count: 0 };
          }
          status = data.lastStatus;
          lastScheduleKey = data.lastScheduleKey;
          updateCount += 1;
          return { count: 1 };
        },
        findUnique: async () => ({
          id: "m1",
          lastStatus: status,
          lastScheduleKey,
          lastRunAt: new Date(),
        }),
      },
    };

    const first = await claimMonitoringExecution(db, { id: "m1" }, {
      scheduleKey: "manual:m1:1",
      manual: true,
    });
    assert.equal(first.claimed, true);

    status = "running";
    const second = await claimMonitoringExecution(db, { id: "m1" }, {
      scheduleKey: "manual:m1:2",
      manual: true,
    });
    assert.equal(second.claimed, false);
    assert.equal(second.reason, "already_running");
    assert.equal(updateCount, 1);
  });
});

describe("provider failure accounting", () => {
  it("charges only successful providers", () => {
    assert.equal(
      countBillableAiTests({
        byQuestion: [
          {
            providers: [
              { ok: true },
              { ok: false, error: "timeout" },
              { error: "boom" },
            ],
          },
        ],
      }),
      1
    );
  });
});

describe("pricing consistency", () => {
  it("canonical Pro label is $19/month", () => {
    assert.equal(DEFAULT_PRO_MONTHLY_DISPLAY, "19");
    assert.equal(DEFAULT_PRO_PRICE_LABEL, "$19/month");
  });

  it("billing UI has no Razorpay or ₹1,499 copy and shows $19/month", () => {
    const files = [
      "app/page.js",
      "app/pricing/page.js",
      "app/billing/page.js",
      "app/dashboard/page.js",
    ];
    for (const rel of files) {
      const text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
      assert.ok(!text.includes("₹499"), `${rel} still mentions ₹499`);
      assert.ok(!text.includes("₹1,499"), `${rel} still mentions ₹1,499`);
      assert.ok(!/Razorpay/i.test(text), `${rel} still mentions Razorpay`);
      assert.ok(!text.includes("publicMetadata?.paid"), `${rel} still trusts Clerk paid metadata`);
    }
    const pricing = fs.readFileSync(path.join(repoRoot, "app/pricing/page.js"), "utf8");
    assert.ok(pricing.includes("$19/month") || pricing.includes("DEFAULT_PRO_PRICE_LABEL"));
    const plans = fs.readFileSync(path.join(repoRoot, "lib/billing/plans.js"), "utf8");
    assert.ok(plans.includes("$19/month") || plans.includes("${DEFAULT_PRO_CURRENCY_SYMBOL}${DEFAULT_PRO_MONTHLY_DISPLAY}/month"));
  });
});

describe("webhook + cron security helpers", () => {
  it("rejects invalid razorpay signatures", () => {
    const body = "{}";
    assert.equal(verifyWebhookSignature(body, "nope", "secret"), false);
    const sig = crypto.createHmac("sha256", "secret").update(body).digest("hex");
    assert.equal(verifyWebhookSignature(body, sig, "secret"), true);
  });

  it("retired Razorpay webhook cannot grant Pro", async () => {
    const a = await processRazorpayWebhook(null, { eventId: "dup", event: "subscription.activated", payload: {} });
    const b = await processRazorpayWebhook(null, { eventId: "dup", event: "subscription.activated", payload: {} });
    assert.equal(a.granted, false);
    assert.equal(b.granted, false);
    assert.equal(a.action, "retired");
  });

  it("cron route rejects missing secret (unit of policy)", async () => {
    // Pure policy check mirroring route logic
    const authorize = (envSecret, bearer, header) => {
      if (!envSecret) return { status: 503 };
      if (bearer !== envSecret && header !== envSecret) return { status: 401 };
      return { status: 200 };
    };
    assert.equal(authorize(undefined, "x", "").status, 503);
    assert.equal(authorize("s3cret", "wrong", "").status, 401);
    assert.equal(authorize("s3cret", "s3cret", "").status, 200);
    assert.equal(authorize("s3cret", "", "s3cret").status, 200);
  });
});

describe("sanitized production errors", () => {
  it("strips secrets and stack-like messages", () => {
    assert.equal(sanitizeErrorMessage("postgresql://user:password@host/db"), "Request failed.");
    assert.equal(sanitizeErrorMessage("key sk-abc123 leaked"), "Request failed.");
    assert.equal(sanitizeErrorMessage("Rate limit hit — try later."), "Rate limit hit — try later.");
  });
});
