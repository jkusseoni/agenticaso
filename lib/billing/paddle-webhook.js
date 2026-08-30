/**
 * Idempotent Paddle Billing webhook processing (signature already verified).
 * Pro is granted only after a verified Paddle paid subscription for the configured Pro price.
 * Events are marked applied only after a successful (or permanent-reject) outcome so
 * transient failures can be retried.
 *
 * Transaction.payment_failed never writes subscription state. Pre-subscription
 * failures (null subscription_id) are ignored. Renewal failures defer to
 * subscription.updated / subscription.canceled. Transaction upserts never reset
 * cancelAtPeriodEnd. Older occurred_at must not overwrite newer state.
 */
import { PLAN_IDS } from "./plans.js";
import { hasVerifiedPaidEntitlement } from "./entitlements.js";
import {
  getPaddleProPriceId,
  mapPaddleSubscriptionStatus,
  paddleEntityMatchesProPrice,
} from "./paddle.js";
import { upsertSubscriptionFromProvider, syncClerkPaidFlag } from "./subscription.js";

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ eventId: string, eventType: string, data?: object, payload?: object }} input
 */
export async function processPaddleWebhook(prisma, { eventId, eventType, data, payload }) {
  if (!eventId) {
    const err = new Error("Missing webhook event id.");
    err.code = "VALIDATION";
    throw err;
  }

  const id = eventId.startsWith("paddle:") ? eventId : `paddle:${eventId}`;
  const type = String(eventType || payload?.event_type || "").toLowerCase();
  const entity = data || payload?.data || {};
  const occurredAt = toDate(payload?.occurred_at);

  const claim = await claimWebhookEvent(prisma, {
    id,
    type: type || "unknown",
    payload: payload || {},
  });
  if (claim.duplicate) {
    return { processed: false, duplicate: true, granted: false };
  }

  try {
    const outcome = await applyPaddleEvent(prisma, { type, entity, occurredAt });
    await markWebhookApplied(prisma, id);
    return { processed: true, granted: outcome.granted === true, action: outcome.action, reason: outcome.reason || null };
  } catch (e) {
    if (e?.code === "WEBHOOK_REJECTED") {
      await markWebhookApplied(prisma, id);
      console.error("paddle webhook rejected:", e.reason || "rejected");
      return { processed: true, granted: false, action: "rejected", reason: e.reason || "rejected" };
    }
    // Transient failure: leave applied=false so Paddle retry can apply later.
    throw e;
  }
}

async function claimWebhookEvent(prisma, { id, type, payload }) {
  try {
    await prisma.billingWebhookEvent.create({
      data: {
        id,
        provider: "paddle",
        type,
        payload,
        applied: false,
      },
    });
    return { duplicate: false };
  } catch (e) {
    if (e?.code !== "P2002") throw e;
    const existing = await prisma.billingWebhookEvent.findUnique({ where: { id } });
    if (existing?.applied === true) {
      return { duplicate: true };
    }
    return { duplicate: false, retry: true };
  }
}

async function markWebhookApplied(prisma, id) {
  await prisma.billingWebhookEvent.update({
    where: { id },
    data: { applied: true },
  });
}

async function applyPaddleEvent(prisma, { type, entity, occurredAt }) {
  if (type.startsWith("subscription.")) {
    return syncFromPaddleSubscription(prisma, entity, type, occurredAt);
  }
  if (type === "transaction.completed") {
    return syncFromCompletedTransaction(prisma, entity, type, occurredAt);
  }
  if (type === "transaction.payment_failed" || type === "transaction.past_due") {
    return handlePaymentFailedTransaction(entity);
  }
  return { granted: false, action: "ignored" };
}

/**
 * payment_failed is not authoritative for subscription lifecycle.
 * Paddle sends subscription_id=null on initial checkout declines (normal).
 */
function handlePaymentFailedTransaction(entity) {
  const subscriptionId = String(entity?.subscription_id || "").trim();
  if (!subscriptionId) {
    return { granted: false, action: "ignored", reason: "pre_subscription_payment_failure" };
  }
  return { granted: false, action: "ignored", reason: "subscription_payment_failure_deferred" };
}

async function syncFromPaddleSubscription(prisma, entity, type, occurredAt) {
  assertProPrice(entity);
  const workspace = await resolveWorkspaceOrReject(prisma, entity?.custom_data);
  if (!entity?.id) {
    throw webhookRejected("missing_subscription_id");
  }

  const existing = await findWorkspaceSubscription(prisma, workspace.id);
  if (isStalePaddleEvent(existing, occurredAt)) {
    return {
      granted: hasVerifiedPaidEntitlement(existing),
      action: "ignored",
      reason: "stale_event",
    };
  }

  const period = entity.current_billing_period || {};
  const status = mapPaddleSubscriptionStatus(entity.status);
  const canceled = status === "cancelled";
  const cancelAtPeriodEnd = entity?.scheduled_change?.action === "cancel" || canceled;

  const sub = await upsertSubscriptionFromProvider(prisma, {
    workspaceId: workspace.id,
    plan: PLAN_IDS.PRO,
    status,
    provider: "paddle",
    providerCustomerId: entity.customer_id || null,
    providerSubscriptionId: entity.id,
    currentPeriodStart: toDate(period.starts_at),
    currentPeriodEnd: toDate(period.ends_at),
    cancelAtPeriodEnd,
    lastPaddleEventAt: occurredAt,
  });

  const granted = hasVerifiedPaidEntitlement(sub);
  await syncClerkPaidFlag(workspace.clerkUserId, granted);
  return { granted, action: type };
}

async function syncFromCompletedTransaction(prisma, entity, type, occurredAt) {
  assertProPrice(entity);
  const workspace = await resolveWorkspaceOrReject(prisma, entity?.custom_data);

  const subscriptionId = entity.subscription_id || null;
  if (!subscriptionId) {
    throw webhookRejected("missing_subscription_id");
  }

  const existing = await findWorkspaceSubscription(prisma, workspace.id);
  if (isStalePaddleEvent(existing, occurredAt)) {
    return {
      granted: hasVerifiedPaidEntitlement(existing),
      action: "ignored",
      reason: "stale_event",
    };
  }

  const period = entity.billing_period || {};
  const txnStatus = String(entity.status || "").toLowerCase();
  const status = txnStatus === "completed" ? "active" : mapPaddleSubscriptionStatus(txnStatus);

  const sub = await upsertSubscriptionFromProvider(prisma, {
    workspaceId: workspace.id,
    plan: PLAN_IDS.PRO,
    status,
    provider: "paddle",
    providerCustomerId: entity.customer_id || null,
    providerSubscriptionId: subscriptionId,
    currentPeriodStart: toDate(period.starts_at),
    currentPeriodEnd: toDate(period.ends_at),
    lastPaddleEventAt: occurredAt,
    // cancelAtPeriodEnd omitted — transaction events must not reset a scheduled cancel.
  });

  const granted = hasVerifiedPaidEntitlement(sub);
  await syncClerkPaidFlag(workspace.clerkUserId, granted);
  return { granted, action: type };
}

async function findWorkspaceSubscription(prisma, workspaceId) {
  if (!workspaceId || !prisma?.subscription?.findUnique) return null;
  try {
    return await prisma.subscription.findUnique({ where: { workspaceId } });
  } catch {
    return null;
  }
}

/**
 * Skip state writes when this event is older than or equal to the last applied Paddle event.
 * Missing occurred_at does not block first-time apply (Paddle always sends it in production).
 */
export function isStalePaddleEvent(existing, occurredAt) {
  if (!existing?.lastPaddleEventAt || !occurredAt) return false;
  const last = new Date(existing.lastPaddleEventAt);
  if (!Number.isFinite(last.getTime())) return false;
  return occurredAt.getTime() <= last.getTime();
}

function assertProPrice(entity) {
  const priceIdPro = getPaddleProPriceId();
  if (!priceIdPro) {
    const err = new Error("Paddle Price ID is not configured.");
    err.code = "PADDLE_PRICE_ID_MISSING";
    throw err;
  }
  if (!paddleEntityMatchesProPrice(entity, priceIdPro)) {
    throw webhookRejected("price_mismatch");
  }
}

async function resolveWorkspaceOrReject(prisma, customData) {
  const workspaceId = String(customData?.workspaceId || "").trim();
  const clerkUserId = String(customData?.clerkUserId || "").trim();
  if (!workspaceId && !clerkUserId) {
    throw webhookRejected("missing_custom_data");
  }

  let workspace = null;
  if (workspaceId) {
    workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  }
  if (!workspace && clerkUserId) {
    workspace = await prisma.workspace.findUnique({ where: { clerkUserId } });
  }
  if (!workspace?.id) {
    throw webhookRejected("workspace_not_found");
  }
  if (clerkUserId && workspace.clerkUserId && workspace.clerkUserId !== clerkUserId) {
    throw webhookRejected("identity_mismatch");
  }
  return workspace;
}

function webhookRejected(reason) {
  const err = new Error("Webhook rejected.");
  err.code = "WEBHOOK_REJECTED";
  err.reason = reason;
  return err;
}

function toDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}
