/**
 * Shared monitoring entitlement + usage preflight (cron + Run Now).
 * Reuses lib/billing — does not duplicate plan logic.
 */
import { getEntitlements, upgradePayload } from "./entitlements.js";
import { preflightAudit } from "./gates.js";
import { expectedAiTestsForAudit } from "./entitlements.js";
import { getUsageSnapshot, reserveUsage } from "./usage.js";
import { PLAN_IDS } from "./plans.js";

/**
 * Load entitlements for a monitoring workspace.
 * Provider-verified subscription is the only paid source — Clerk paid is ignored.
 */
export function entitlementsForWorkspace(workspace, _opts = {}) {
  void _opts.clerkPaid;
  return getEntitlements(workspace?.subscription || null);
}

/**
 * Preflight + reserve for a monitoring multi-AI run.
 * Call BEFORE claim/run. Does not start providers.
 *
 * @returns {Promise<
 *   | { ok: true, expectedAiTests: number, reserved: number, questions: object[], entitlements: object, usage: object }
 *   | { ok: false, status: string, reason: string, upgrade?: object }
 * >}
 */
export async function prepareMonitoringUsage(db, monitoring, { clerkPaid = false, providerCount = 3 } = {}) {
  const website = monitoring?.website;
  const workspace = website?.workspace;
  if (!website || !workspace?.id) {
    return { ok: false, status: "error", reason: "Website or workspace missing." };
  }

  // Ensure subscription is loaded if caller only passed workspace id fields
  let ws = workspace;
  if (!ws.subscription && ws.id) {
    const full = await db.workspace.findUnique({
      where: { id: ws.id },
      include: { subscription: true },
    });
    if (full) ws = full;
  }

  const entitlements = entitlementsForWorkspace(ws);
  const monLimit = entitlements.entitlements?.monitoring;

  if (!entitlements.isPaid || monLimit === 0) {
    return {
      ok: false,
      status: "skipped_entitlement",
      reason: "Monitoring requires an active Pro subscription.",
      upgrade: upgradePayload({
        planId: entitlements.planId || PLAN_IDS.FREE,
        feature: "monitoring",
        message: "Monitoring requires Pro. Upgrade to unlock weekly monitoring.",
      }),
    };
  }

  const questions = await db.buyerQuestion.findMany({
    where: { websiteId: website.id, active: true },
    orderBy: { createdAt: "asc" },
    take: Math.min(50, entitlements.entitlements?.buyerQuestions || 50),
  });

  if (!questions.length) {
    return {
      ok: false,
      status: "skipped",
      reason: "No active buyer questions. Run an initial audit to seed questions.",
    };
  }

  const expectedAiTests = expectedAiTestsForAudit({
    questionCount: questions.length,
    providerCount,
  });

  const usage = await getUsageSnapshot(db, ws.id);
  // Preflight against effective usage (committed + reserved)
  const flight = preflightAudit({
    entitlements,
    usage: { ...usage, aiTests: usage.aiTestsEffective ?? usage.aiTests },
    questionCount: questions.length,
    providerCount,
  });
  if (!flight.ok) {
    return {
      ok: false,
      status: "skipped_usage",
      reason: flight.upgrade?.message || "Insufficient AI test allowance for this monitoring run.",
      upgrade: flight.upgrade,
      expectedAiTests,
    };
  }

  const reserved = await reserveUsage(
    db,
    ws.id,
    {
      aiTests: expectedAiTests,
      limit: entitlements.entitlements?.aiTestsPerMonth,
    }
  );

  if (!reserved.ok) {
    return {
      ok: false,
      status: "skipped_usage",
      reason: "Insufficient AI test allowance (concurrent reservation).",
      upgrade: upgradePayload({
        planId: entitlements.planId,
        feature: "aiTests",
        used: reserved.used,
        limit: reserved.limit,
        message: `Monitoring needs ~${expectedAiTests} AI tests. Allowance exhausted this period.`,
      }),
      expectedAiTests,
    };
  }

  return {
    ok: true,
    expectedAiTests,
    reserved: reserved.reserved,
    questions,
    entitlements,
    usage,
    workspaceId: ws.id,
  };
}
