import { getPlan, PLAN_IDS, isUnlimited } from "./plans.js";

/**
 * Statuses that may grant Pro when a Paddle subscription id AND a valid future
 * currentPeriodEnd are present. past_due is included so dunning/retry does not
 * strip already-paid access before the paid period ends.
 * Unpaid checkout placeholders (trialing) and paused/expired do NOT grant Pro.
 */
export const ACTIVE_SUBSCRIPTION_STATUSES = Object.freeze(["active", "cancelled", "past_due"]);

/** Only Paddle can grant Pro. */
export const PAID_PROVIDER = "paddle";

/**
 * True when the workspace has a Paddle-issued subscription identifier.
 */
export function hasProviderPaymentProof(subscription) {
  if (!subscription || typeof subscription !== "object") return false;
  const provider = String(subscription.provider || "").trim().toLowerCase();
  if (provider !== PAID_PROVIDER) return false;
  return String(subscription.providerSubscriptionId || "").trim().length > 0;
}

/**
 * True when currentPeriodEnd is a real timestamp strictly after `now`.
 * Missing or invalid period never grants Pro (no indefinite access).
 */
export function hasOpenPaidPeriod(subscription, now = new Date()) {
  if (!subscription?.currentPeriodEnd) return false;
  const end = new Date(subscription.currentPeriodEnd);
  return Number.isFinite(end.getTime()) && end.getTime() > now.getTime();
}

/**
 * Verified paid access: Paddle provider + subscription id + qualifying status
 * + valid currentPeriodEnd still in the future.
 *
 * Qualifying statuses: active, cancelled (scheduled/ended cancel), past_due
 * (Paddle dunning). Pro lasts only while currentPeriodEnd > now.
 *
 * Login, email verification, and Clerk publicMetadata.paid NEVER grant Pro.
 * Razorpay rows, trialing, paused, expired, and missing/invalid period NEVER grant Pro.
 */
export function hasVerifiedPaidEntitlement(subscription, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  if (!hasProviderPaymentProof(subscription)) return false;

  const status = String(subscription.status || "").toLowerCase();
  if (!ACTIVE_SUBSCRIPTION_STATUSES.includes(status)) return false;
  return hasOpenPaidPeriod(subscription, now);
}

/**
 * Resolve effective plan id from a server-side subscription record only.
 * @param {{ plan?: string|null, status?: string|null, providerSubscriptionId?: string|null, currentPeriodEnd?: Date|string|null } | null | undefined} subscription
 * @param {{ now?: Date, clerkPaid?: boolean, emailVerified?: boolean }} [opts]
 */
export function resolvePlanId(subscription, opts = {}) {
  // Explicitly ignored — must never activate Pro:
  // opts.clerkPaid, opts.emailVerified, browser-supplied paid flags
  void opts.clerkPaid;
  void opts.emailVerified;

  if (!hasVerifiedPaidEntitlement(subscription, opts)) {
    return PLAN_IDS.FREE;
  }

  const plan = String(subscription?.plan || "").toLowerCase();
  if (plan === PLAN_IDS.AGENCY) return PLAN_IDS.AGENCY;
  return PLAN_IDS.PRO;
}

function publicStatus(subscription, isPaid) {
  const status = subscription?.status ? String(subscription.status).toLowerCase() : "";
  if (isPaid) {
    return status === "cancelled" ? "cancelled" : "active";
  }
  if (!status || status === "active") return "none";
  return status;
}

/**
 * @param {{ plan?: string|null, status?: string|null } | null | undefined} subscription
 * @param {{ clerkPaid?: boolean, emailVerified?: boolean, now?: Date }} [opts]
 */
export function getEntitlements(subscription, opts = {}) {
  const planId = resolvePlanId(subscription, opts);
  const plan = getPlan(planId);
  const isPaid = planId !== PLAN_IDS.FREE;

  return {
    planId,
    planName: plan.name,
    status: publicStatus(subscription, isPaid),
    isPaid,
    entitlements: { ...plan },
    cancelAtPeriodEnd: Boolean(subscription?.cancelAtPeriodEnd),
    currentPeriodEnd: subscription?.currentPeriodEnd || null,
    provider: subscription?.provider || null,
  };
}

/**
 * Check a numeric limit against current usage.
 * @returns {{ ok: boolean, limit: number|null, used: number, remaining: number|null, reason?: string }}
 */
export function checkLimit(limit, used, key = "limit") {
  const u = Math.max(0, Number(used) || 0);
  if (isUnlimited(limit)) {
    return { ok: true, limit: null, used: u, remaining: null };
  }
  const max = Math.max(0, Number(limit) || 0);
  if (u >= max) {
    return {
      ok: false,
      limit: max,
      used: u,
      remaining: 0,
      reason: `${key}_exceeded`,
    };
  }
  return { ok: true, limit: max, used: u, remaining: max - u };
}

/**
 * Expected AI tests for a multi-provider audit (preflight).
 * Failed calls are not consumed later — this is the max expected cost.
 */
export function expectedAiTestsForAudit({ questionCount, providerCount = 3 } = {}) {
  const q = Math.max(0, Number(questionCount) || 0);
  const p = Math.max(0, Number(providerCount) || 0);
  return q * p;
}

/**
 * Count billable AI tests from a completed audit / visibility payload.
 * Failed provider calls do not count. Explicit providerCalled:false does not count.
 */
export function countBillableAiTests(auditResult) {
  const collect = [];
  if (Array.isArray(auditResult?.results)) collect.push(...auditResult.results);
  for (const row of auditResult?.byQuestion || []) {
    if (Array.isArray(row?.providers)) collect.push(...row.providers);
  }
  if (!auditResult?.byQuestion?.length && Array.isArray(auditResult?.providers)) {
    collect.push(...auditResult.providers);
  }

  let n = 0;
  for (const r of collect) {
    if (!r) continue;
    if (r.ok === false) continue;
    if (r.meta?.providerCalled === false) continue;
    if (r.error) continue;
    n += 1;
  }
  return n;
}

export function upgradePayload({
  planId = PLAN_IDS.FREE,
  feature,
  used,
  limit,
  message,
} = {}) {
  const target = planId === PLAN_IDS.FREE ? PLAN_IDS.PRO : PLAN_IDS.AGENCY;
  return {
    upgrade: true,
    code: "ENTITLEMENT_REQUIRED",
    feature: feature || null,
    plan: planId,
    suggestedPlan: target,
    used: used ?? null,
    limit: limit ?? null,
    message:
      message ||
      (limit != null && used != null
        ? `You've used ${used}/${limit}. Upgrade to unlock more.`
        : "Upgrade your plan to unlock this feature."),
  };
}
