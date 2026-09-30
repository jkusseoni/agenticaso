/**
 * Phase F P0 — Paddle Billing hardening (mocked; no live Paddle API).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PLAN_IDS,
  DEFAULT_PRO_PRICE_LABEL,
  DEFAULT_PRO_MONTHLY_CENTS,
  getEntitlements,
  hasVerifiedPaidEntitlement,
  resolvePlanId,
  verifyPaddleWebhookSignature,
  mapPaddleSubscriptionStatus,
  getPaddleProPriceId,
  isPaddleConfigured,
  isPaddleEnvAligned,
  buildPaddleCheckoutCustomData,
  paddleEntityMatchesProPrice,
  applyRazorpaySubscriptionEntity,
  createProSubscription,
} from "../index.js";
import { processPaddleWebhook } from "../paddle-webhook.js";
import { processRazorpayWebhook } from "../webhook.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TEST_PRICE = "pri_test_agenticaso_pro_19";
const WRONG_PRICE = "pri_test_other_product";

const PREV = {
  PADDLE_PRICE_ID_PRO: process.env.PADDLE_PRICE_ID_PRO,
  PADDLE_ENV: process.env.PADDLE_ENV,
  NEXT_PUBLIC_PADDLE_ENV: process.env.NEXT_PUBLIC_PADDLE_ENV,
  PADDLE_API_KEY: process.env.PADDLE_API_KEY,
};

before(() => {
  process.env.PADDLE_PRICE_ID_PRO = TEST_PRICE;
  process.env.PADDLE_ENV = "sandbox";
  process.env.NEXT_PUBLIC_PADDLE_ENV = "sandbox";
});

after(() => {
  restoreEnv("PADDLE_PRICE_ID_PRO", PREV.PADDLE_PRICE_ID_PRO);
  restoreEnv("PADDLE_ENV", PREV.PADDLE_ENV);
  restoreEnv("NEXT_PUBLIC_PADDLE_ENV", PREV.NEXT_PUBLIC_PADDLE_ENV);
  restoreEnv("PADDLE_API_KEY", PREV.PADDLE_API_KEY);
});

function restoreEnv(key, value) {
  if (value == null) delete process.env[key];
  else process.env[key] = value;
}

function signPaddleBody(rawBody, secret, ts = Math.floor(Date.now() / 1000)) {
  const h1 = crypto.createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest("hex");
  return { header: `ts=${ts};h1=${h1}`, ts, h1 };
}

function withPrice(entity, priceId = TEST_PRICE) {
  return {
    ...entity,
    items: [{ price: { id: priceId }, price_id: priceId }],
  };
}

function matchesSubscriptionWhere(row, where) {
  if (!where) return true;
  if (where.workspaceId != null && row.workspaceId !== where.workspaceId) return false;
  if (where.providerSubscriptionId != null && row.providerSubscriptionId !== where.providerSubscriptionId) return false;
  if (Object.prototype.hasOwnProperty.call(where, "firstPaidAt")) {
    const cond = where.firstPaidAt;
    if (cond === null && row.firstPaidAt != null) return false;
    if (cond && typeof cond === "object" && cond.not === null && row.firstPaidAt == null) return false;
  }
  if (Object.prototype.hasOwnProperty.call(where, "firstPaidTransactionId")) {
    const cond = where.firstPaidTransactionId;
    if (cond === null && row.firstPaidTransactionId != null) return false;
  }
  return true;
}

function fakePrisma({ failUpserts = 0 } = {}) {
  const events = new Map();
  const workspaces = [
    { id: "ws_1", clerkUserId: "user_1", email: "buyer@example.com" },
  ];
  const subscriptions = new Map();
  let remainingFails = failUpserts;
  const client = {
    billingWebhookEvent: {
      create: async ({ data }) => {
        if (events.has(data.id)) {
          const err = new Error("duplicate");
          err.code = "P2002";
          throw err;
        }
        const row = { applied: false, ...data };
        events.set(data.id, row);
        return row;
      },
      findUnique: async ({ where }) => events.get(where.id) || null,
      update: async ({ where, data }) => {
        const row = events.get(where.id);
        if (!row) {
          const err = new Error("missing");
          err.code = "P2025";
          throw err;
        }
        Object.assign(row, data);
        return row;
      },
    },
    workspace: {
      findUnique: async ({ where }) => {
        if (where.id) return workspaces.find((w) => w.id === where.id) || null;
        if (where.clerkUserId) return workspaces.find((w) => w.clerkUserId === where.clerkUserId) || null;
        return null;
      },
    },
    subscription: {
      findUnique: async ({ where }) => {
        if (where.workspaceId) return subscriptions.get(where.workspaceId) || null;
        return null;
      },
      upsert: async ({ where, create, update }) => {
        if (remainingFails > 0) {
          remainingFails -= 1;
          throw new Error("transient_db_error");
        }
        const existing = subscriptions.get(where.workspaceId);
        const row = existing ? { ...existing, ...update } : { id: "sub_local", ...create };
        subscriptions.set(where.workspaceId, row);
        return row;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of subscriptions.values()) {
          if (!matchesSubscriptionWhere(row, where)) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      },
    },
    _subscriptions: subscriptions,
    _events: events,
  };
  client.$transaction = async (fn) => fn(client);
  return client;
}

describe("Paddle v2 signature verification", () => {
  it("accepts a valid ts+h1 signature and rejects tampering", () => {
    const body = JSON.stringify({ event_id: "evt_1", event_type: "transaction.completed" });
    const secret = "pdl_ntfset_test";
    const { header } = signPaddleBody(body, secret);
    assert.equal(verifyPaddleWebhookSignature(body, header, secret), true);
    assert.equal(verifyPaddleWebhookSignature(body, header, "wrong"), false);
    assert.equal(verifyPaddleWebhookSignature(body + "x", header, secret), false);
    assert.equal(verifyPaddleWebhookSignature(body, "ts=1;h1=deadbeef", secret), false);
    assert.equal(verifyPaddleWebhookSignature(body, header, ""), false);
  });
});

describe("Paddle price id configuration", () => {
  it("reads only PADDLE_PRICE_ID_PRO and keeps $19 display", () => {
    assert.equal(getPaddleProPriceId(), TEST_PRICE);
    assert.equal(DEFAULT_PRO_PRICE_LABEL, "$19/month");
    assert.equal(DEFAULT_PRO_MONTHLY_CENTS, 1900);
    assert.equal(paddleEntityMatchesProPrice(withPrice({}), TEST_PRICE), true);
    assert.equal(paddleEntityMatchesProPrice(withPrice({}, WRONG_PRICE), TEST_PRICE), false);
  });

  it("missing Price ID fails safely and does not grant Pro", async () => {
    const prev = process.env.PADDLE_PRICE_ID_PRO;
    delete process.env.PADDLE_PRICE_ID_PRO;
    assert.equal(getPaddleProPriceId(), "");
    const prisma = fakePrisma();
    await assert.rejects(
      () =>
        processPaddleWebhook(prisma, {
          eventId: "evt_no_price",
          eventType: "transaction.completed",
          data: withPrice({
            status: "completed",
            subscription_id: "sub_x",
            custom_data: { workspaceId: "ws_1", clerkUserId: "user_1" },
          }),
        }),
      (err) => err.code === "PADDLE_PRICE_ID_MISSING"
    );
    assert.equal(prisma._subscriptions.size, 0);
    const event = prisma._events.get("paddle:evt_no_price");
    assert.equal(event?.applied, false);
    restoreEnv("PADDLE_PRICE_ID_PRO", prev || TEST_PRICE);
  });
});

describe("Paddle webhook price + identity guards", () => {
  it("correct Pro price id is accepted", async () => {
    const prisma = fakePrisma();
    const result = await processPaddleWebhook(prisma, {
      eventId: "evt_paid",
      eventType: "transaction.completed",
      data: withPrice({
        id: "txn_1",
        status: "completed",
        subscription_id: "sub_01paid",
        customer_id: "ctm_1",
        custom_data: { workspaceId: "ws_1", clerkUserId: "user_1" },
        billing_period: {
          starts_at: "2027-08-01T00:00:00Z",
          ends_at: "2027-09-01T00:00:00Z",
        },
      }),
    });
    assert.equal(result.granted, true);
    const e = getEntitlements(prisma._subscriptions.get("ws_1"));
    assert.equal(e.isPaid, true);
    assert.equal(e.planId, PLAN_IDS.PRO);
    assert.equal(e.provider, "paddle");
  });

  it("wrong Paddle Price ID is rejected and does not grant Pro", async () => {
    const prisma = fakePrisma();
    const result = await processPaddleWebhook(prisma, {
      eventId: "evt_wrong",
      eventType: "subscription.created",
      data: withPrice(
        {
          id: "sub_other",
          status: "active",
          custom_data: { workspaceId: "ws_1", clerkUserId: "user_1" },
        },
        WRONG_PRICE
      ),
    });
    assert.equal(result.granted, false);
    assert.equal(result.reason, "price_mismatch");
    assert.equal(prisma._subscriptions.size, 0);
    assert.equal(prisma._events.get("paddle:evt_wrong").applied, true);
  });

  it("missing custom_data does not grant Pro", async () => {
    const prisma = fakePrisma();
    const result = await processPaddleWebhook(prisma, {
      eventId: "evt_no_cd",
      eventType: "subscription.created",
      data: withPrice({ id: "sub_1", status: "active" }),
    });
    assert.equal(result.granted, false);
    assert.equal(result.reason, "missing_custom_data");
    assert.equal(prisma._subscriptions.size, 0);
  });

  it("invalid custom_data does not grant Pro", async () => {
    const prisma = fakePrisma();
    const result = await processPaddleWebhook(prisma, {
      eventId: "evt_bad_ws",
      eventType: "subscription.updated",
      data: withPrice({
        id: "sub_1",
        status: "active",
        custom_data: { workspaceId: "ws_unknown", clerkUserId: "user_unknown" },
      }),
    });
    assert.equal(result.granted, false);
    assert.equal(result.reason, "workspace_not_found");
    assert.equal(prisma._subscriptions.size, 0);
  });

  it("identity mismatch does not grant Pro", async () => {
    const prisma = fakePrisma();
    const result = await processPaddleWebhook(prisma, {
      eventId: "evt_mismatch",
      eventType: "subscription.created",
      data: withPrice({
        id: "sub_1",
        status: "active",
        custom_data: { workspaceId: "ws_1", clerkUserId: "someone_else" },
      }),
    });
    assert.equal(result.granted, false);
    assert.equal(result.reason, "identity_mismatch");
    assert.equal(prisma._subscriptions.size, 0);
  });
});

describe("Paddle webhook idempotency + retry", () => {
  it("is idempotent on duplicate event ids after successful apply", async () => {
    const prisma = fakePrisma();
    const payload = {
      event_id: "evt_dup",
      event_type: "subscription.activated",
      data: withPrice({
        id: "sub_01paddle",
        status: "active",
        customer_id: "ctm_1",
        custom_data: { workspaceId: "ws_1", clerkUserId: "user_1" },
        current_billing_period: {
          starts_at: "2027-08-01T00:00:00Z",
          ends_at: "2027-09-01T00:00:00Z",
        },
      }),
    };
    const first = await processPaddleWebhook(prisma, {
      eventId: payload.event_id,
      eventType: payload.event_type,
      data: payload.data,
      payload,
    });
    const second = await processPaddleWebhook(prisma, {
      eventId: payload.event_id,
      eventType: payload.event_type,
      data: payload.data,
      payload,
    });
    assert.equal(first.processed, true);
    assert.equal(first.granted, true);
    assert.equal(second.duplicate, true);
    assert.equal(prisma._events.size, 1);
    assert.equal(prisma._subscriptions.size, 1);
  });

  it("apply failure then retry succeeds without duplicate subscriptions", async () => {
    const prisma = fakePrisma({ failUpserts: 1 });
    const data = withPrice({
      id: "sub_retry",
      status: "active",
      custom_data: { workspaceId: "ws_1", clerkUserId: "user_1" },
      current_billing_period: {
        starts_at: "2027-08-01T00:00:00Z",
        ends_at: "2027-09-01T00:00:00Z",
      },
    });
    await assert.rejects(() =>
      processPaddleWebhook(prisma, {
        eventId: "evt_retry",
        eventType: "subscription.created",
        data,
      })
    );
    assert.equal(prisma._events.get("paddle:evt_retry").applied, false);
    assert.equal(prisma._subscriptions.size, 0);

    const second = await processPaddleWebhook(prisma, {
      eventId: "evt_retry",
      eventType: "subscription.created",
      data,
    });
    assert.equal(second.granted, true);
    assert.equal(second.duplicate, undefined);
    assert.equal(prisma._events.get("paddle:evt_retry").applied, true);
    assert.equal(prisma._subscriptions.size, 1);
  });

  it("failed payment cannot grant Pro", async () => {
    const failedDb = fakePrisma();
    const result = await processPaddleWebhook(failedDb, {
      eventId: "evt_fail",
      eventType: "transaction.payment_failed",
      data: withPrice({
        status: "past_due",
        subscription_id: "sub_fail",
        custom_data: { workspaceId: "ws_1", clerkUserId: "user_1" },
      }),
    });
    assert.equal(result.granted, false);
    assert.equal(result.action, "ignored");
    assert.equal(failedDb._subscriptions.size, 0);
    assert.equal(getEntitlements(failedDb._subscriptions.get("ws_1")).isPaid, false);
  });

  it("maps Paddle statuses without treating unpaid as active", () => {
    assert.equal(mapPaddleSubscriptionStatus("active"), "active");
    assert.equal(mapPaddleSubscriptionStatus("trialing"), "trialing");
    assert.equal(mapPaddleSubscriptionStatus("canceled"), "cancelled");
    assert.equal(mapPaddleSubscriptionStatus("past_due"), "past_due");
    assert.equal(
      getEntitlements({
        plan: "pro",
        status: "trialing",
        provider: "paddle",
        providerSubscriptionId: "sub_trial",
      }).isPaid,
      false
    );
  });
});

describe("entitlement rules", () => {
  it("Clerk paid cannot grant Pro", () => {
    assert.equal(resolvePlanId(null, { clerkPaid: true, emailVerified: true }), PLAN_IDS.FREE);
    assert.equal(getEntitlements(null, { clerkPaid: true }).isPaid, false);
  });

  it("Razorpay rows cannot grant Pro", () => {
    const rzp = {
      plan: "pro",
      status: "active",
      provider: "razorpay",
      providerSubscriptionId: "sub_rzp",
    };
    assert.equal(hasVerifiedPaidEntitlement(rzp), false);
    assert.equal(getEntitlements(rzp).isPaid, false);
  });

  it("cancellation with remaining paid period remains Pro", () => {
    const end = new Date(Date.now() + 7 * 86400_000);
    const e = getEntitlements({
      plan: "pro",
      status: "cancelled",
      provider: "paddle",
      providerSubscriptionId: "sub_1",
      currentPeriodEnd: end,
    });
    assert.equal(e.isPaid, true);
  });

  it("expired cancellation becomes Free", () => {
    const past = new Date(Date.now() - 86400_000);
    const e = getEntitlements({
      plan: "pro",
      status: "cancelled",
      provider: "paddle",
      providerSubscriptionId: "sub_1",
      currentPeriodEnd: past,
    });
    assert.equal(e.isPaid, false);
  });
});

describe("retired Razorpay cannot grant Pro", () => {
  it("processRazorpayWebhook does not upsert a paid subscription", async () => {
    const prisma = fakePrisma();
    const result = await processRazorpayWebhook(prisma, {
      eventId: "rzp_1",
      event: "subscription.activated",
      payload: { payload: { subscription: { entity: { id: "sub_rzp", status: "active" } } } },
    });
    assert.equal(result.granted, false);
    assert.equal(result.action, "retired");
    assert.equal(prisma._subscriptions.size, 0);
    assert.equal(await applyRazorpaySubscriptionEntity(), null);
    await assert.rejects(() => createProSubscription(), (err) => err.code === "PROVIDER_RETIRED");
  });
});

describe("checkout does not grant Pro", () => {
  it("checkout route does not upsert subscriptions and sends custom_data identity", () => {
    const checkout = fs.readFileSync(path.join(repoRoot, "app/api/billing/checkout/route.js"), "utf8");
    assert.ok(checkout.includes("createPaddleCheckoutTransaction"));
    assert.ok(!/subscription\.upsert/i.test(checkout));
    assert.ok(!/razorpay/i.test(checkout));
    assert.ok(checkout.includes("PADDLE_PRICE_ID_MISSING"));
    const custom = buildPaddleCheckoutCustomData({ workspaceId: "ws_1", clerkUserId: "user_1" });
    assert.equal(custom.workspaceId, "ws_1");
    assert.equal(custom.clerkUserId, "user_1");
    assert.equal(custom.plan, "pro");
  });

  it("does not read NEXT_PUBLIC_PADDLE_PRO_PRICE_ID", () => {
    const paddle = fs.readFileSync(path.join(repoRoot, "lib/billing/paddle.js"), "utf8");
    assert.ok(paddle.includes("PADDLE_PRICE_ID_PRO"));
    assert.equal(paddle.includes("NEXT_PUBLIC_PADDLE_PRO_PRICE_ID"), true);
    assert.match(paddle, /Never read NEXT_PUBLIC_PADDLE_PRO_PRICE_ID/);
    assert.equal(paddle.includes("process.env.NEXT_PUBLIC_PADDLE_PRO_PRICE_ID"), false);
    assert.equal(paddle.includes("process.env.NEXT_PUBLIC_PADDLE_PRICE_ID"), false);
  });

  it("sandbox/live mismatch is not silent", () => {
    process.env.PADDLE_ENV = "production";
    process.env.NEXT_PUBLIC_PADDLE_ENV = "sandbox";
    assert.equal(isPaddleEnvAligned(), false);
    assert.equal(isPaddleConfigured(), false);
    process.env.PADDLE_ENV = "sandbox";
    process.env.NEXT_PUBLIC_PADDLE_ENV = "sandbox";
    assert.equal(isPaddleEnvAligned(), true);
  });
});

describe("Phase F checkout surfaces", () => {
  it("adds the Paddle webhook route, overlay helper, and env keys", () => {
    assert.ok(fs.existsSync(path.join(repoRoot, "app/api/webhooks/paddle/route.js")));
    const webhook = fs.readFileSync(path.join(repoRoot, "app/api/webhooks/paddle/route.js"), "utf8");
    assert.ok(webhook.includes("verifyPaddleWebhookSignature"));
    assert.ok(webhook.includes("processPaddleWebhook"));

    const retired = fs.readFileSync(path.join(repoRoot, "app/api/billing/webhook/route.js"), "utf8");
    assert.ok(retired.includes("PROVIDER_RETIRED"));
    assert.ok(!retired.includes("processRazorpayWebhook"));

    const overlay = fs.readFileSync(path.join(repoRoot, "components/billing/paddle-checkout.js"), "utf8");
    assert.ok(overlay.includes("@paddle/paddle-js"));
    assert.ok(overlay.includes("sandbox"));

    const env = fs.readFileSync(path.join(repoRoot, ".env.example"), "utf8");
    for (const key of [
      "PADDLE_API_KEY",
      "PADDLE_WEBHOOK_SECRET",
      "PADDLE_PRICE_ID_PRO",
      "PADDLE_ENV",
      "NEXT_PUBLIC_PADDLE_CLIENT_TOKEN",
      "NEXT_PUBLIC_PADDLE_ENV",
    ]) {
      assert.ok(env.includes(key), `missing ${key}`);
    }
    assert.equal(env.includes("RAZORPAY_KEY_ID="), false);
  });
});

function futureEnd(days = 30) {
  return new Date(Date.now() + days * 86_400_000);
}

function iso(d) {
  return new Date(d).toISOString();
}

function seedPaid(prisma, overrides = {}) {
  const end = overrides.currentPeriodEnd || futureEnd();
  const row = {
    id: "sub_local",
    workspaceId: "ws_1",
    plan: PLAN_IDS.PRO,
    status: "active",
    provider: "paddle",
    providerSubscriptionId: "sub_01paid",
    currentPeriodStart: new Date("2026-08-30T00:00:00.000Z"),
    currentPeriodEnd: end,
    cancelAtPeriodEnd: false,
    lastPaddleEventAt: new Date("2026-08-30T09:19:00.000Z"),
    ...overrides,
  };
  prisma._subscriptions.set("ws_1", row);
  return row;
}

describe("Phase F.1 edge-case hardening", () => {
  it("A. initial checkout payment_failed with null subscription_id is ignored", async () => {
    const prisma = fakePrisma();
    const result = await processPaddleWebhook(prisma, {
      eventId: "evt_pre_fail",
      eventType: "transaction.payment_failed",
      data: withPrice({
        status: "ready",
        subscription_id: null,
        origin: "api",
        custom_data: { workspaceId: "ws_1", clerkUserId: "user_1" },
      }),
    });
    assert.equal(result.processed, true);
    assert.equal(result.granted, false);
    assert.equal(result.action, "ignored");
    assert.equal(result.reason, "pre_subscription_payment_failure");
    assert.equal(prisma._subscriptions.size, 0);
    assert.equal(prisma._events.get("paddle:evt_pre_fail").applied, true);
  });

  it("B. renewal payment_failed preserves cancel flag, period, and Pro", async () => {
    const prisma = fakePrisma();
    const end = futureEnd(20);
    seedPaid(prisma, { cancelAtPeriodEnd: true, currentPeriodEnd: end });
    const result = await processPaddleWebhook(prisma, {
      eventId: "evt_renew_fail",
      eventType: "transaction.payment_failed",
      data: withPrice({
        status: "past_due",
        subscription_id: "sub_01paid",
        custom_data: { workspaceId: "ws_1", clerkUserId: "user_1" },
      }),
    });
    assert.equal(result.action, "ignored");
    assert.equal(result.reason, "subscription_payment_failure_deferred");
    const row = prisma._subscriptions.get("ws_1");
    assert.equal(row.cancelAtPeriodEnd, true);
    assert.equal(row.status, "active");
    assert.equal(new Date(row.currentPeriodEnd).getTime(), end.getTime());
    assert.equal(getEntitlements(row).isPaid, true);
    assert.equal(prisma._subscriptions.size, 1);
  });

  it("C. past_due + future period stays Pro", () => {
    assert.equal(
      hasVerifiedPaidEntitlement({
        plan: "pro",
        status: "past_due",
        provider: "paddle",
        providerSubscriptionId: "sub_1",
        currentPeriodEnd: futureEnd(),
      }),
      true
    );
  });

  it("D. past_due + expired period is Free", () => {
    assert.equal(
      hasVerifiedPaidEntitlement({
        plan: "pro",
        status: "past_due",
        provider: "paddle",
        providerSubscriptionId: "sub_1",
        currentPeriodEnd: new Date(Date.now() - 86_400_000),
      }),
      false
    );
  });

  it("E. active + null currentPeriodEnd is Free", () => {
    assert.equal(
      hasVerifiedPaidEntitlement({
        plan: "pro",
        status: "active",
        provider: "paddle",
        providerSubscriptionId: "sub_1",
        currentPeriodEnd: null,
      }),
      false
    );
  });

  it("F. cancelled + future period stays Pro", () => {
    assert.equal(
      hasVerifiedPaidEntitlement({
        plan: "pro",
        status: "cancelled",
        provider: "paddle",
        providerSubscriptionId: "sub_1",
        currentPeriodEnd: futureEnd(),
      }),
      true
    );
  });

  it("G. cancelled + expired period is Free", () => {
    assert.equal(
      hasVerifiedPaidEntitlement({
        plan: "pro",
        status: "cancelled",
        provider: "paddle",
        providerSubscriptionId: "sub_1",
        currentPeriodEnd: new Date(Date.now() - 86_400_000),
      }),
      false
    );
  });

  it("H. transaction.completed does not clear cancelAtPeriodEnd", async () => {
    const prisma = fakePrisma();
    seedPaid(prisma, { cancelAtPeriodEnd: true, lastPaddleEventAt: new Date("2026-08-30T08:00:00.000Z") });
    await processPaddleWebhook(prisma, {
      eventId: "evt_txn_keep_cancel",
      eventType: "transaction.completed",
      payload: { occurred_at: "2026-08-30T10:00:00.000Z" },
      data: withPrice({
        status: "completed",
        subscription_id: "sub_01paid",
        custom_data: { workspaceId: "ws_1", clerkUserId: "user_1" },
        billing_period: {
          starts_at: "2026-08-30T00:00:00Z",
          ends_at: iso(futureEnd(31)),
        },
      }),
    });
    assert.equal(prisma._subscriptions.get("ws_1").cancelAtPeriodEnd, true);
    assert.equal(prisma._subscriptions.size, 1);
  });

  it("I. transaction.payment_failed does not clear cancelAtPeriodEnd", async () => {
    const prisma = fakePrisma();
    seedPaid(prisma, { cancelAtPeriodEnd: true });
    await processPaddleWebhook(prisma, {
      eventId: "evt_fail_keep_cancel",
      eventType: "transaction.payment_failed",
      data: withPrice({
        subscription_id: "sub_01paid",
        custom_data: { workspaceId: "ws_1", clerkUserId: "user_1" },
      }),
    });
    assert.equal(prisma._subscriptions.get("ws_1").cancelAtPeriodEnd, true);
  });

  it("J. stale subscription.updated cannot overwrite newer period/status/cancel", async () => {
    const prisma = fakePrisma();
    const newEnd = new Date("2026-10-30T00:00:00.000Z");
    seedPaid(prisma, {
      status: "active",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: newEnd,
      lastPaddleEventAt: new Date("2026-09-15T12:00:00.000Z"),
    });
    const result = await processPaddleWebhook(prisma, {
      eventId: "evt_stale_sub",
      eventType: "subscription.updated",
      payload: { occurred_at: "2026-08-01T00:00:00.000Z" },
      data: withPrice({
        id: "sub_01paid",
        status: "past_due",
        custom_data: { workspaceId: "ws_1", clerkUserId: "user_1" },
        current_billing_period: {
          starts_at: "2026-07-01T00:00:00Z",
          ends_at: "2026-08-01T00:00:00Z",
        },
      }),
    });
    assert.equal(result.action, "ignored");
    assert.equal(result.reason, "stale_event");
    const row = prisma._subscriptions.get("ws_1");
    assert.equal(row.status, "active");
    assert.equal(row.cancelAtPeriodEnd, true);
    assert.equal(new Date(row.currentPeriodEnd).toISOString(), newEnd.toISOString());
  });

  it("K. stale transaction.completed cannot undo newer cancellation", async () => {
    const prisma = fakePrisma();
    seedPaid(prisma, {
      status: "cancelled",
      cancelAtPeriodEnd: true,
      lastPaddleEventAt: new Date("2026-09-01T12:00:00.000Z"),
    });
    const result = await processPaddleWebhook(prisma, {
      eventId: "evt_stale_txn",
      eventType: "transaction.completed",
      payload: { occurred_at: "2026-08-30T09:00:00.000Z" },
      data: withPrice({
        status: "completed",
        subscription_id: "sub_01paid",
        custom_data: { workspaceId: "ws_1", clerkUserId: "user_1" },
        billing_period: {
          starts_at: "2026-08-01T00:00:00Z",
          ends_at: "2026-09-01T00:00:00Z",
        },
      }),
    });
    assert.equal(result.reason, "stale_event");
    const row = prisma._subscriptions.get("ws_1");
    assert.equal(row.status, "cancelled");
    assert.equal(row.cancelAtPeriodEnd, true);
  });

  it("L. duplicate Paddle event remains idempotent", async () => {
    const prisma = fakePrisma();
    const payload = {
      event_id: "evt_f1_dup",
      event_type: "subscription.updated",
      occurred_at: "2026-08-30T11:00:00.000Z",
      data: withPrice({
        id: "sub_01paid",
        status: "active",
        custom_data: { workspaceId: "ws_1", clerkUserId: "user_1" },
        current_billing_period: {
          starts_at: "2027-08-30T00:00:00Z",
          ends_at: "2027-09-30T00:00:00Z",
        },
      }),
    };
    const first = await processPaddleWebhook(prisma, {
      eventId: payload.event_id,
      eventType: payload.event_type,
      data: payload.data,
      payload,
    });
    const second = await processPaddleWebhook(prisma, {
      eventId: payload.event_id,
      eventType: payload.event_type,
      data: payload.data,
      payload,
    });
    assert.equal(first.granted, true);
    assert.equal(second.duplicate, true);
    assert.equal(prisma._events.size, 1);
    assert.equal(prisma._subscriptions.size, 1);
  });

  it("M. successful renewal advances period on one row and keeps Pro", async () => {
    const prisma = fakePrisma();
    seedPaid(prisma, {
      currentPeriodEnd: new Date("2026-09-30T00:00:00.000Z"),
      lastPaddleEventAt: new Date("2026-08-30T09:19:00.000Z"),
    });
    const result = await processPaddleWebhook(prisma, {
      eventId: "evt_renew",
      eventType: "subscription.updated",
      payload: { occurred_at: "2026-09-30T00:01:00.000Z" },
      data: withPrice({
        id: "sub_01paid",
        status: "active",
        custom_data: { workspaceId: "ws_1", clerkUserId: "user_1" },
        current_billing_period: {
          starts_at: "2026-09-30T00:00:00Z",
          ends_at: "2026-10-30T00:00:00Z",
        },
      }),
    });
    assert.equal(result.granted, true);
    assert.equal(prisma._subscriptions.size, 1);
    const row = prisma._subscriptions.get("ws_1");
    assert.equal(new Date(row.currentPeriodEnd).toISOString(), "2026-10-30T00:00:00.000Z");
    assert.equal(getEntitlements(row).isPaid, true);
  });

  it("N. Razorpay row cannot grant Pro", () => {
    assert.equal(
      hasVerifiedPaidEntitlement({
        plan: "pro",
        status: "active",
        provider: "razorpay",
        providerSubscriptionId: "sub_rzp",
        currentPeriodEnd: futureEnd(),
      }),
      false
    );
  });

  it("O. Clerk paid flag cannot grant Pro", () => {
    assert.equal(resolvePlanId(null, { clerkPaid: true }), PLAN_IDS.FREE);
    assert.equal(
      hasVerifiedPaidEntitlement(null, { clerkPaid: true }),
      false
    );
  });
});

const FIRST_CUSTOM = { workspaceId: "ws_1", clerkUserId: "user_1" };
const FIRST_PERIOD = {
  starts_at: "2027-06-01T00:00:00.000Z",
  ends_at: "2027-07-01T00:00:00.000Z",
};
const FIRST_TOTALS = { grand_total: "1900", currency_code: "usd" };

function completedTxn(overrides = {}) {
  return withPrice({
    id: "txn_first",
    status: "completed",
    subscription_id: "sub_first",
    customer_id: "ctm_1",
    custom_data: FIRST_CUSTOM,
    billing_period: FIRST_PERIOD,
    details: { totals: FIRST_TOTALS },
    payments: [{ method_details: { card: { last4: "4242", type: "visa" } } }],
    ...overrides,
  });
}

function activatedSub(overrides = {}) {
  return withPrice({
    id: "sub_first",
    status: "active",
    customer_id: "ctm_1",
    custom_data: FIRST_CUSTOM,
    current_billing_period: FIRST_PERIOD,
    ...overrides,
  });
}

describe("first-paid conversion", () => {
  it("first transaction.completed records firstPaidAt, transaction id, and valid totals once", async () => {
    const prisma = fakePrisma();
    const result = await processPaddleWebhook(prisma, {
      eventId: "evt_first_txn",
      eventType: "transaction.completed",
      payload: { occurred_at: "2027-06-01T00:02:00.000Z" },
      data: completedTxn(),
    });
    assert.equal(result.granted, true);
    const row = prisma._subscriptions.get("ws_1");
    assert.equal(new Date(row.firstPaidAt).toISOString(), "2027-06-01T00:02:00.000Z");
    assert.equal(row.firstPaidTransactionId, "txn_first");
    assert.equal(row.firstPaidAmount, 1900);
    assert.equal(row.firstPaidCurrency, "USD");
    assert.equal(row.last4, undefined);
    assert.equal(row.card, undefined);
    assert.equal(getEntitlements(row).isPaid, true);
    assert.equal(prisma._subscriptions.size, 1);
  });

  it("invalid grand_total does not store amount or currency", async () => {
    const prisma = fakePrisma();
    await processPaddleWebhook(prisma, {
      eventId: "evt_bad_total",
      eventType: "transaction.completed",
      payload: { occurred_at: "2027-06-01T00:02:00.000Z" },
      data: completedTxn({
        details: { totals: { grand_total: "19.00", currency_code: "USD" } },
      }),
    });
    const row = prisma._subscriptions.get("ws_1");
    assert.equal(row.firstPaidTransactionId, "txn_first");
    assert.equal(row.firstPaidAmount, undefined);
    assert.equal(row.firstPaidCurrency, undefined);
    assert.ok(row.firstPaidAt);
  });

  it("duplicate event id does not duplicate the conversion", async () => {
    const prisma = fakePrisma();
    const payload = {
      event_id: "evt_dup_first",
      event_type: "transaction.completed",
      occurred_at: "2027-06-01T00:02:00.000Z",
      data: completedTxn(),
    };
    const first = await processPaddleWebhook(prisma, {
      eventId: payload.event_id,
      eventType: payload.event_type,
      data: payload.data,
      payload,
    });
    const second = await processPaddleWebhook(prisma, {
      eventId: payload.event_id,
      eventType: payload.event_type,
      data: payload.data,
      payload,
    });
    assert.equal(first.granted, true);
    assert.equal(second.duplicate, true);
    assert.equal(prisma._subscriptions.size, 1);
    assert.equal(prisma._events.size, 1);
    const row = prisma._subscriptions.get("ws_1");
    assert.equal(new Date(row.firstPaidAt).toISOString(), "2027-06-01T00:02:00.000Z");
    assert.equal(row.firstPaidTransactionId, "txn_first");
  });

  it("transaction.completed then subscription.activated keeps one conversion", async () => {
    const prisma = fakePrisma();
    await processPaddleWebhook(prisma, {
      eventId: "evt_txn_then_sub",
      eventType: "transaction.completed",
      payload: { occurred_at: "2027-06-01T00:02:00.000Z" },
      data: completedTxn(),
    });
    await processPaddleWebhook(prisma, {
      eventId: "evt_sub_after_txn",
      eventType: "subscription.activated",
      payload: { occurred_at: "2027-06-01T00:03:00.000Z" },
      data: activatedSub(),
    });
    const row = prisma._subscriptions.get("ws_1");
    assert.equal(prisma._subscriptions.size, 1);
    assert.equal(new Date(row.firstPaidAt).toISOString(), "2027-06-01T00:02:00.000Z");
    assert.equal(row.firstPaidTransactionId, "txn_first");
    assert.equal(row.firstPaidAmount, 1900);
    assert.equal(row.firstPaidCurrency, "USD");
  });

  it("subscription.activated then transaction.completed fills metadata without moving firstPaidAt", async () => {
    const prisma = fakePrisma();
    await processPaddleWebhook(prisma, {
      eventId: "evt_sub_first",
      eventType: "subscription.activated",
      payload: { occurred_at: "2027-06-01T00:02:00.000Z" },
      data: activatedSub(),
    });
    const stamped = prisma._subscriptions.get("ws_1");
    assert.equal(new Date(stamped.firstPaidAt).toISOString(), "2027-06-01T00:02:00.000Z");
    assert.equal(stamped.firstPaidTransactionId ?? null, null);

    await processPaddleWebhook(prisma, {
      eventId: "evt_txn_after_sub",
      eventType: "transaction.completed",
      payload: { occurred_at: "2027-06-01T00:04:00.000Z" },
      data: completedTxn(),
    });
    const row = prisma._subscriptions.get("ws_1");
    assert.equal(new Date(row.firstPaidAt).toISOString(), "2027-06-01T00:02:00.000Z");
    assert.equal(row.firstPaidTransactionId, "txn_first");
    assert.equal(row.firstPaidAmount, 1900);
    assert.equal(row.firstPaidCurrency, "USD");
  });

  it("stale transaction.completed still fills metadata and does not move firstPaidAt", async () => {
    const prisma = fakePrisma();
    await processPaddleWebhook(prisma, {
      eventId: "evt_sub_newer",
      eventType: "subscription.activated",
      payload: { occurred_at: "2027-06-01T00:10:00.000Z" },
      data: activatedSub(),
    });
    const result = await processPaddleWebhook(prisma, {
      eventId: "evt_txn_older",
      eventType: "transaction.completed",
      payload: { occurred_at: "2027-06-01T00:02:00.000Z" },
      data: completedTxn(),
    });
    assert.equal(result.reason, "stale_event");
    const row = prisma._subscriptions.get("ws_1");
    assert.equal(new Date(row.firstPaidAt).toISOString(), "2027-06-01T00:10:00.000Z");
    assert.equal(row.firstPaidTransactionId, "txn_first");
    assert.equal(row.firstPaidAmount, 1900);
    assert.equal(row.firstPaidCurrency, "USD");
    assert.equal(new Date(row.lastPaddleEventAt).toISOString(), "2027-06-01T00:10:00.000Z");
  });

  it("renewal transaction.completed does not change firstPaidAt or transaction id", async () => {
    const prisma = fakePrisma();
    const firstPaidAt = new Date("2027-06-01T00:02:00.000Z");
    seedPaid(prisma, {
      providerSubscriptionId: "sub_first",
      currentPeriodStart: new Date(FIRST_PERIOD.starts_at),
      currentPeriodEnd: new Date(FIRST_PERIOD.ends_at),
      lastPaddleEventAt: firstPaidAt,
      firstPaidAt,
      firstPaidTransactionId: "txn_first",
      firstPaidAmount: 1900,
      firstPaidCurrency: "USD",
    });
    const result = await processPaddleWebhook(prisma, {
      eventId: "evt_renewal_txn",
      eventType: "transaction.completed",
      payload: { occurred_at: "2027-07-01T00:02:00.000Z" },
      data: completedTxn({
        id: "txn_renewal",
        billing_period: {
          starts_at: "2027-07-01T00:00:00.000Z",
          ends_at: "2027-08-01T00:00:00.000Z",
        },
        details: { totals: { grand_total: "1900", currency_code: "USD" } },
      }),
    });
    assert.equal(result.granted, true);
    const row = prisma._subscriptions.get("ws_1");
    assert.equal(new Date(row.firstPaidAt).toISOString(), firstPaidAt.toISOString());
    assert.equal(row.firstPaidTransactionId, "txn_first");
    assert.equal(row.firstPaidAmount, 1900);
    assert.equal(new Date(row.currentPeriodEnd).toISOString(), "2027-08-01T00:00:00.000Z");
  });

  it("renewal does not claim a missing first transaction id", async () => {
    const prisma = fakePrisma();
    const firstPaidAt = new Date("2027-06-01T00:02:00.000Z");
    seedPaid(prisma, {
      providerSubscriptionId: "sub_first",
      currentPeriodStart: new Date(FIRST_PERIOD.starts_at),
      currentPeriodEnd: new Date(FIRST_PERIOD.ends_at),
      lastPaddleEventAt: firstPaidAt,
      firstPaidAt,
      firstPaidTransactionId: null,
    });
    await processPaddleWebhook(prisma, {
      eventId: "evt_renewal_blank_id",
      eventType: "transaction.completed",
      payload: { occurred_at: "2027-07-01T00:02:00.000Z" },
      data: completedTxn({
        id: "txn_renewal",
        billing_period: {
          starts_at: "2027-07-01T00:00:00.000Z",
          ends_at: "2027-08-01T00:00:00.000Z",
        },
      }),
    });
    const row = prisma._subscriptions.get("ws_1");
    assert.equal(new Date(row.firstPaidAt).toISOString(), firstPaidAt.toISOString());
    assert.equal(row.firstPaidTransactionId, null);
  });

  it("cancellation preserves firstPaidAt", async () => {
    const prisma = fakePrisma();
    const firstPaidAt = new Date("2027-06-01T00:02:00.000Z");
    seedPaid(prisma, {
      providerSubscriptionId: "sub_first",
      currentPeriodStart: new Date(FIRST_PERIOD.starts_at),
      currentPeriodEnd: new Date(FIRST_PERIOD.ends_at),
      lastPaddleEventAt: firstPaidAt,
      firstPaidAt,
      firstPaidTransactionId: "txn_first",
    });
    await processPaddleWebhook(prisma, {
      eventId: "evt_cancel",
      eventType: "subscription.updated",
      payload: { occurred_at: "2027-06-15T00:00:00.000Z" },
      data: activatedSub({
        status: "canceled",
        scheduled_change: { action: "cancel" },
      }),
    });
    const row = prisma._subscriptions.get("ws_1");
    assert.equal(row.status, "cancelled");
    assert.equal(row.cancelAtPeriodEnd, true);
    assert.equal(new Date(row.firstPaidAt).toISOString(), firstPaidAt.toISOString());
    assert.equal(row.firstPaidTransactionId, "txn_first");
  });

  it("reactivation does not create a second first-paid conversion", async () => {
    const prisma = fakePrisma();
    const firstPaidAt = new Date("2026-05-01T00:02:00.000Z");
    seedPaid(prisma, {
      status: "cancelled",
      cancelAtPeriodEnd: true,
      providerSubscriptionId: "sub_first",
      currentPeriodStart: new Date("2026-05-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-05-15T00:00:00.000Z"),
      lastPaddleEventAt: new Date("2026-05-20T00:00:00.000Z"),
      firstPaidAt,
      firstPaidTransactionId: "txn_first",
    });
    assert.equal(getEntitlements(prisma._subscriptions.get("ws_1")).isPaid, false);
    await processPaddleWebhook(prisma, {
      eventId: "evt_reactivate",
      eventType: "subscription.updated",
      payload: { occurred_at: "2027-08-01T00:02:00.000Z" },
      data: activatedSub({
        current_billing_period: {
          starts_at: "2027-08-01T00:00:00.000Z",
          ends_at: "2027-09-01T00:00:00.000Z",
        },
      }),
    });
    const row = prisma._subscriptions.get("ws_1");
    assert.equal(getEntitlements(row).isPaid, true);
    assert.equal(row.status, "active");
    assert.equal(new Date(row.firstPaidAt).toISOString(), firstPaidAt.toISOString());
    assert.equal(row.firstPaidTransactionId, "txn_first");
    assert.equal(prisma._subscriptions.size, 1);
  });

  it("payment_failed does not record a conversion", async () => {
    const prisma = fakePrisma();
    const result = await processPaddleWebhook(prisma, {
      eventId: "evt_fail_first",
      eventType: "transaction.payment_failed",
      data: completedTxn({ status: "past_due", subscription_id: null, id: "txn_fail" }),
    });
    assert.equal(result.granted, false);
    assert.equal(prisma._subscriptions.size, 0);
  });

  it("trialing does not record a conversion", async () => {
    const prisma = fakePrisma();
    const result = await processPaddleWebhook(prisma, {
      eventId: "evt_trial",
      eventType: "subscription.created",
      payload: { occurred_at: "2027-06-01T00:02:00.000Z" },
      data: activatedSub({ status: "trialing" }),
    });
    assert.equal(result.granted, false);
    const row = prisma._subscriptions.get("ws_1");
    assert.equal(row.status, "trialing");
    assert.equal(row.firstPaidAt ?? null, null);
    assert.equal(getEntitlements(row).isPaid, false);
  });

  it("wrong price does not record a conversion", async () => {
    const prisma = fakePrisma();
    const result = await processPaddleWebhook(prisma, {
      eventId: "evt_wrong_price_first",
      eventType: "transaction.completed",
      payload: { occurred_at: "2027-06-01T00:02:00.000Z" },
      data: withPrice(completedTxn(), WRONG_PRICE),
    });
    assert.equal(result.granted, false);
    assert.equal(result.reason, "price_mismatch");
    assert.equal(prisma._subscriptions.size, 0);
  });

  it("identity mismatch does not record a conversion", async () => {
    const prisma = fakePrisma();
    const result = await processPaddleWebhook(prisma, {
      eventId: "evt_identity_first",
      eventType: "transaction.completed",
      payload: { occurred_at: "2027-06-01T00:02:00.000Z" },
      data: completedTxn({
        custom_data: { workspaceId: "ws_1", clerkUserId: "someone_else" },
      }),
    });
    assert.equal(result.granted, false);
    assert.equal(result.reason, "identity_mismatch");
    assert.equal(prisma._subscriptions.size, 0);
  });

  it("conditional update prevents a second firstPaid stamp", async () => {
    const prisma = fakePrisma();
    await Promise.all([
      processPaddleWebhook(prisma, {
        eventId: "evt_race_txn",
        eventType: "transaction.completed",
        payload: { occurred_at: "2027-06-01T00:02:00.000Z" },
        data: completedTxn(),
      }),
      processPaddleWebhook(prisma, {
        eventId: "evt_race_sub",
        eventType: "subscription.activated",
        payload: { occurred_at: "2027-06-01T00:02:01.000Z" },
        data: activatedSub(),
      }),
    ]);
    const row = prisma._subscriptions.get("ws_1");
    assert.equal(prisma._subscriptions.size, 1);
    assert.ok(row.firstPaidAt);
    const stamped = new Date(row.firstPaidAt).toISOString();
    const second = await prisma.subscription.updateMany({
      where: { workspaceId: "ws_1", firstPaidAt: null },
      data: { firstPaidAt: new Date("2030-01-01T00:00:00.000Z") },
    });
    assert.equal(second.count, 0);
    assert.equal(new Date(row.firstPaidAt).toISOString(), stamped);
    assert.notEqual(stamped, "2030-01-01T00:00:00.000Z");
  });
});
