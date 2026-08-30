import { PLAN_IDS } from "./plans.js";
import { getEntitlements } from "./entitlements.js";

/**
 * Upsert subscription from verified webhook / server checkout.
 * Does not trust client-supplied plan or status.
 */
export async function upsertSubscriptionFromProvider(prisma, {
  workspaceId,
  plan = PLAN_IDS.PRO,
  status,
  provider = null,
  providerCustomerId = null,
  providerSubscriptionId = null,
  providerPaymentLinkId = null,
  currentPeriodStart = null,
  currentPeriodEnd = null,
  cancelAtPeriodEnd,
  lastPaddleEventAt = null,
}) {
  const safePlan = plan === PLAN_IDS.AGENCY ? PLAN_IDS.AGENCY : PLAN_IDS.PRO;
  const safeStatus = status || "expired";
  // Transaction events omit cancelAtPeriodEnd so a scheduled cancel is not cleared.
  const touchCancel = cancelAtPeriodEnd !== undefined;

  return prisma.subscription.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      plan: safePlan,
      status: safeStatus,
      provider,
      providerCustomerId,
      providerSubscriptionId,
      providerPaymentLinkId,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd: touchCancel ? Boolean(cancelAtPeriodEnd) : false,
      lastPaddleEventAt,
    },
    update: {
      plan: safePlan,
      status: safeStatus,
      provider,
      ...(providerCustomerId != null ? { providerCustomerId } : {}),
      ...(providerSubscriptionId != null ? { providerSubscriptionId } : {}),
      ...(providerPaymentLinkId != null ? { providerPaymentLinkId } : {}),
      ...(currentPeriodStart != null ? { currentPeriodStart } : {}),
      ...(currentPeriodEnd != null ? { currentPeriodEnd } : {}),
      ...(touchCancel ? { cancelAtPeriodEnd: Boolean(cancelAtPeriodEnd) } : {}),
      ...(lastPaddleEventAt != null ? { lastPaddleEventAt } : {}),
    },
  });
}

/**
 * Best-effort Clerk metadata sync. MUST NOT be used to grant Pro.
 * Entitlements ignore publicMetadata.paid.
 */
export async function syncClerkPaidFlag(clerkUserId, isPaid) {
  if (!clerkUserId) return;
  try {
    const { clerkClient } = await import("@clerk/nextjs/server");
    const client = await clerkClient();
    const user = await client.users.getUser(clerkUserId);
    const current = user?.publicMetadata || {};
    if (current.paid === isPaid) return;
    await client.users.updateUserMetadata(clerkUserId, {
      publicMetadata: { ...current, paid: isPaid },
    });
  } catch (e) {
    console.error("clerk paid sync failed:", e?.message || e);
  }
}

/**
 * Retired. Razorpay must not grant, activate, or restore Pro.
 * Historical Subscription rows are left unchanged.
 */
export async function applyRazorpaySubscriptionEntity() {
  return null;
}

/**
 * Downgrade: keep data, set free entitlements via status.
 */
export async function markSubscriptionInactive(prisma, workspaceId, status = "expired", clerkUserId = null) {
  const sub = await prisma.subscription.findUnique({ where: { workspaceId } });
  if (!sub) return null;
  const updated = await prisma.subscription.update({
    where: { workspaceId },
    data: { status, cancelAtPeriodEnd: false },
  });
  if (clerkUserId) await syncClerkPaidFlag(clerkUserId, false);
  return updated;
}

/**
 * Public billing status payload (no secrets).
 */
export function toBillingStatusView({ entitlements, usage, websiteCount = 0, monitoringCount = 0 }) {
  const e = entitlements || getEntitlements(null);
  const plan = e.entitlements;
  return {
    plan: e.planId,
    planName: e.planName,
    status: e.status,
    isPaid: e.isPaid,
    cancelAtPeriodEnd: e.cancelAtPeriodEnd,
    currentPeriodEnd: e.currentPeriodEnd,
    usage: {
      aiTests: {
        used: usage?.aiTests ?? 0,
        limit: plan.aiTestsPerMonth,
      },
      websites: {
        used: websiteCount,
        limit: plan.websites,
      },
      monitoring: {
        used: monitoringCount,
        limit: plan.monitoring,
      },
      buyerQuestions: {
        limit: plan.buyerQuestions,
      },
      audits: {
        used: usage?.audits ?? 0,
      },
      periodStart: usage?.periodStart || null,
      periodEnd: usage?.periodEnd || null,
    },
    features: {
      advancedCompetitors: plan.advancedCompetitors,
      advancedDiagnosis: plan.advancedDiagnosis,
      exports: plan.exports !== 0 && plan.exports !== false,
    },
  };
}
