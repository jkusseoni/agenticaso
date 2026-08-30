import {
  checkLimit,
  expectedAiTestsForAudit,
  getEntitlements,
  upgradePayload,
} from "./entitlements.js";
import { PLAN_IDS, isUnlimited } from "./plans.js";
import { getUsageSnapshot } from "./usage.js";

/**
 * Require a boolean entitlement flag (advancedCompetitors, advancedDiagnosis).
 * For numeric limits use checkLimit / preflightAudit / checkMonitoringSlots.
 */
export function requireEntitlement(ctx, flag) {
  const entitlements = ctx?.entitlements?.entitlements || ctx?.entitlements;
  const planId = ctx?.entitlements?.planId || ctx?.planId || PLAN_IDS.FREE;
  const value = entitlements?.[flag];
  const allowed =
    value === true ||
    (flag === "exports" && value !== 0 && value !== false);
  if (!entitlements || !allowed) {
    const upgrade = upgradePayload({
      planId,
      feature: flag,
      message: `This requires a higher plan (${flag}).`,
    });
    return {
      ok: false,
      upgrade,
      response: Response.json(upgrade, { status: 402 }),
    };
  }
  return { ok: true, entitlements };
}

/**
 * Preflight multi-AI audit cost before any provider calls.
 * @returns {{ ok: true, expectedAiTests: number, usage: object, entitlements: object } | { ok: false, response: Response, upgrade: object }}
 */
export function preflightAudit({ entitlements, usage, questionCount, providerCount = 3 }) {
  const plan = entitlements?.entitlements || entitlements;
  const planId = entitlements?.planId || PLAN_IDS.FREE;
  const expected = expectedAiTestsForAudit({ questionCount, providerCount });

  const qMax = plan.buyerQuestions;
  if (!isUnlimited(qMax) && questionCount > Number(qMax || 0)) {
    const upgrade = upgradePayload({
      planId,
      feature: "buyerQuestions",
      used: questionCount,
      limit: Number(qMax),
      message: `You've selected ${questionCount} buyer questions (limit ${qMax}). Unlock 50 questions + weekly monitoring with Pro.`,
    });
    return { ok: false, upgrade, response: Response.json(upgrade, { status: 402 }) };
  }

  const used = Number(usage?.aiTests) || 0;
  const limit = plan.aiTestsPerMonth;
  const remaining =
    limit == null || limit === -1 ? null : Math.max(0, Number(limit) - used);

  if (remaining != null && expected > remaining) {
    const upgrade = upgradePayload({
      planId,
      feature: "aiTests",
      used,
      limit,
      message: `This audit needs ~${expected} AI tests. You've used ${used}/${limit} this period. Upgrade to Pro for more capacity.`,
    });
    return {
      ok: false,
      upgrade,
      expectedAiTests: expected,
      response: Response.json({ ...upgrade, expectedAiTests: expected, remaining }, { status: 402 }),
    };
  }

  return { ok: true, expectedAiTests: expected, usage, entitlements };
}

/**
 * Build full workspace billing context (subscription + usage + entitlements).
 */
export async function loadBillingContext(prisma, workspace, _opts = {}) {
  void _opts.clerkPaid;
  const subscription = workspace?.subscription || null;
  const entitlements = getEntitlements(subscription);
  const usage = workspace?.id
    ? await getUsageSnapshot(prisma, workspace.id)
    : { aiTests: 0, audits: 0, monitoringRuns: 0, periodStart: null, periodEnd: null };

  return { subscription, entitlements, usage, planId: entitlements.planId };
}

/**
 * Gate monitoring create / slot count.
 */
export function checkMonitoringSlots({ entitlements, activeMonitoringCount }) {
  const plan = entitlements?.entitlements || entitlements;
  const planId = entitlements?.planId || PLAN_IDS.FREE;
  const check = checkLimit(plan.monitoring, activeMonitoringCount, "monitoring");
  if (!check.ok) {
    const upgrade = upgradePayload({
      planId,
      feature: "monitoring",
      used: activeMonitoringCount,
      limit: check.limit,
      message:
        check.limit === 0
          ? "Monitoring is a Pro feature. Unlock weekly monitoring with Pro."
          : `You've used ${activeMonitoringCount}/${check.limit} monitoring slots. Upgrade for more.`,
    });
    return { ok: false, upgrade, response: Response.json(upgrade, { status: 402 }) };
  }
  return { ok: true };
}

/**
 * Gate website count.
 */
export function checkWebsiteSlots({ entitlements, websiteCount }) {
  const plan = entitlements?.entitlements || entitlements;
  const planId = entitlements?.planId || PLAN_IDS.FREE;
  const check = checkLimit(plan.websites, websiteCount, "websites");
  if (!check.ok) {
    const upgrade = upgradePayload({
      planId,
      feature: "websites",
      used: websiteCount,
      limit: check.limit,
      message: `You've used ${websiteCount}/${check.limit} websites. Upgrade to add more.`,
    });
    return { ok: false, upgrade, response: Response.json(upgrade, { status: 402 }) };
  }
  return { ok: true };
}
