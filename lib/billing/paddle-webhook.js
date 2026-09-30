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
 *
 * firstPaidAt is historical conversion metadata, not an entitlement input.
 * It is stamped once, when verified paid access goes from false to true.
 * transaction.completed may later fill transaction id, amount, and currency
 * without moving firstPaidAt, including when that event is stale for entitlement sync.
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

  const period = entity.current_billing_period || {};
  const status = mapPaddleSubscriptionStatus(entity.status);
  const canceled = status === "cancelled";
  const cancelAtPeriodEnd = entity?.scheduled_change?.action === "cancel" || canceled;

  const outcome = await dbTransaction(prisma, async (tx) => {
    const existing = await findWorkspaceSubscription(tx, workspace.id);
    if (isStalePaddleEvent(existing, occurredAt)) {
      return {
        granted: hasVerifiedPaidEntitlement(existing),
        action: "ignored",
        reason: "stale_event",
      };
    }

    const beforePaid = hasVerifiedPaidEntitlement(existing);
    const sub = await upsertSubscriptionFromProvider(tx, {
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

    const afterPaid = hasVerifiedPaidEntitlement(sub);
    if (beforePaid === false && afterPaid === true) {
      await stampFirstPaid(tx, {
        workspaceId: workspace.id,
        occurredAt,
      });
    }
    return { granted: afterPaid, action: type };
  });

  await syncClerkPaidFlag(workspace.clerkUserId, outcome.granted);
  return outcome;
}

async function syncFromCompletedTransaction(prisma, entity, type, occurredAt) {
  assertProPrice(entity);
  const workspace = await resolveWorkspaceOrReject(prisma, entity?.custom_data);

  const subscriptionId = entity.subscription_id || null;
  if (!subscriptionId) {
    throw webhookRejected("missing_subscription_id");
  }

  const period = entity.billing_period || {};
  const txnStatus = String(entity.status || "").toLowerCase();
  const status = txnStatus === "completed" ? "active" : mapPaddleSubscriptionStatus(txnStatus);
  const meta = extractFirstPaidTransactionMeta(entity);

  const outcome = await dbTransaction(prisma, async (tx) => {
    const existing = await findWorkspaceSubscription(tx, workspace.id);
    if (isStalePaddleEvent(existing, occurredAt)) {
      await fillFirstPaidTransactionMeta(tx, workspace.id, entity, meta);
      return {
        granted: hasVerifiedPaidEntitlement(existing),
        action: "ignored",
        reason: "stale_event",
      };
    }

    const beforePaid = hasVerifiedPaidEntitlement(existing);
    const sub = await upsertSubscriptionFromProvider(tx, {
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

    const afterPaid = hasVerifiedPaidEntitlement(sub);
    if (beforePaid === false && afterPaid === true) {
      await stampFirstPaid(tx, {
        workspaceId: workspace.id,
        occurredAt,
        meta,
      });
    }
    await fillFirstPaidTransactionMeta(tx, workspace.id, entity, meta);
    return { granted: afterPaid, action: type };
  });

  await syncClerkPaidFlag(workspace.clerkUserId, outcome.granted);
  return outcome;
}

/**
 * Write firstPaidAt once. The WHERE firstPaidAt IS NULL predicate is the lock:
 * overlapping webhooks cannot both stamp.
 * @param {import("@prisma/client").PrismaClient} tx
 */
async function stampFirstPaid(tx, { workspaceId, occurredAt, meta = null }) {
  const data = {
    firstPaidAt: occurredAt || new Date(),
  };
  if (meta?.transactionId) data.firstPaidTransactionId = meta.transactionId;
  if (meta?.amount != null && meta?.currency) {
    data.firstPaidAmount = meta.amount;
    data.firstPaidCurrency = meta.currency;
  }
  await tx.subscription.updateMany({
    where: { workspaceId, firstPaidAt: null },
    data,
  });
}

/**
 * Fill transaction id/amount/currency after subscription.activated won the first stamp.
 * Does not write firstPaidAt and does not replace an existing transaction id.
 * A renewal period does not match firstPaidAt, so it cannot claim the id.
 * @param {import("@prisma/client").PrismaClient} tx
 */
async function fillFirstPaidTransactionMeta(tx, workspaceId, entity, meta) {
  if (!meta?.transactionId) return;
  const subscriptionId = String(entity?.subscription_id || "").trim();
  if (!subscriptionId) return;

  const row = await findWorkspaceSubscription(tx, workspaceId);
  if (!row?.firstPaidAt || row.firstPaidTransactionId) return;
  if (String(row.providerSubscriptionId || "") !== subscriptionId) return;
  if (!transactionMatchesFirstPaidPeriod(row, entity)) return;

  const data = { firstPaidTransactionId: meta.transactionId };
  if (meta.amount != null && meta.currency) {
    data.firstPaidAmount = meta.amount;
    data.firstPaidCurrency = meta.currency;
  }
  await tx.subscription.updateMany({
    where: {
      workspaceId,
      providerSubscriptionId: subscriptionId,
      firstPaidAt: { not: null },
      firstPaidTransactionId: null,
    },
    data,
  });
}

/**
 * Paddle transaction.completed totals. grand_total is minor units.
 * Both amount and currency must parse, or neither is stored.
 * Card and billing-address fields are ignored.
 */
function extractFirstPaidTransactionMeta(entity) {
  const transactionId = String(entity?.id || "").trim() || null;
  const totals = entity?.details?.totals;
  let amount = null;
  let currency = null;
  if (totals && typeof totals === "object" && !Array.isArray(totals)) {
    const currencyCode = String(totals.currency_code || "").trim().toUpperCase();
    const raw = totals.grand_total;
    const text = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : String(raw ?? "").trim();
    if (/^\d+$/.test(text) && /^[A-Z]{3}$/.test(currencyCode)) {
      const parsed = Number(text);
      if (Number.isSafeInteger(parsed)) {
        amount = parsed;
        currency = currencyCode;
      }
    }
  }
  return { transactionId, amount, currency };
}

/**
 * True when this transaction's billing period is the period that contains firstPaidAt.
 * Renewal periods start later, so they do not match.
 */
function transactionMatchesFirstPaidPeriod(row, entity) {
  const start = toDate(entity?.billing_period?.starts_at);
  const end = toDate(entity?.billing_period?.ends_at);
  const rowStart = row?.currentPeriodStart ? new Date(row.currentPeriodStart) : null;
  const paidAt = row?.firstPaidAt ? new Date(row.firstPaidAt) : null;
  if (!start || !rowStart || !paidAt) return false;
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(rowStart.getTime()) || !Number.isFinite(paidAt.getTime())) {
    return false;
  }
  if (start.getTime() !== rowStart.getTime()) return false;
  const earliest = start.getTime() - 48 * 60 * 60 * 1000;
  const latest = end && Number.isFinite(end.getTime()) ? end.getTime() : start.getTime() + 40 * 24 * 60 * 60 * 1000;
  return paidAt.getTime() >= earliest && paidAt.getTime() <= latest;
}

async function dbTransaction(prisma, fn) {
  if (typeof prisma?.$transaction === "function") {
    return prisma.$transaction(fn);
  }
  return fn(prisma);
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
