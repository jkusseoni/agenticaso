/**
 * Usage period helpers — reserve / commit / release for concurrent-safe allowance.
 */
import { isUnlimited } from "./plans.js";

/**
 * Calendar-month UTC billing period containing `now`.
 * @param {Date} [now]
 */
export function currentBillingPeriod(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { periodStart: start, periodEnd: end };
}

/**
 * Ensure a UsagePeriod row exists and return it.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} workspaceId
 * @param {Date} [now]
 */
export async function getOrCreateUsagePeriod(prisma, workspaceId, now = new Date()) {
  const { periodStart, periodEnd } = currentBillingPeriod(now);
  return prisma.usagePeriod.upsert({
    where: {
      workspaceId_periodStart: { workspaceId, periodStart },
    },
    create: {
      workspaceId,
      periodStart,
      periodEnd,
      aiTests: 0,
      aiTestsReserved: 0,
      audits: 0,
      monitoringRuns: 0,
    },
    update: {},
  });
}

/**
 * Atomically reserve expected AI tests so concurrent jobs cannot overspend.
 * Effective used = aiTests + aiTestsReserved.
 *
 * @returns {Promise<{ ok: true, period: object, reserved: number } | { ok: false, reason: string, period?: object }>}
 */
export async function reserveUsage(prisma, workspaceId, { aiTests = 0, limit = null } = {}, now = new Date()) {
  const need = Math.max(0, Number(aiTests) || 0);
  const period = await getOrCreateUsagePeriod(prisma, workspaceId, now);

  if (need === 0) {
    return { ok: true, period, reserved: 0 };
  }

  if (isUnlimited(limit)) {
    const updated = await prisma.usagePeriod.update({
      where: { id: period.id },
      data: { aiTestsReserved: { increment: need } },
    });
    return { ok: true, period: updated, reserved: need };
  }

  const max = Math.max(0, Number(limit) || 0);

  // Conditional update: only reserve if committed + reserved + need <= limit
  const result = await prisma.$executeRaw`
    UPDATE "UsagePeriod"
    SET "aiTestsReserved" = "aiTestsReserved" + ${need},
        "updatedAt" = NOW()
    WHERE "id" = ${period.id}
      AND ("aiTests" + "aiTestsReserved" + ${need}) <= ${max}
  `;

  if (Number(result) !== 1) {
    const fresh = await prisma.usagePeriod.findUnique({ where: { id: period.id } });
    return {
      ok: false,
      reason: "insufficient_allowance",
      period: fresh || period,
      used: (fresh?.aiTests ?? period.aiTests) + (fresh?.aiTestsReserved ?? period.aiTestsReserved),
      limit: max,
      need,
    };
  }

  const fresh = await prisma.usagePeriod.findUnique({ where: { id: period.id } });
  return { ok: true, period: fresh || period, reserved: need };
}

/**
 * After a run: release reservation and commit actual billable usage.
 * actualAiTests should be ≤ reserved; excess is still committed (safety).
 */
export async function commitUsage(
  prisma,
  workspaceId,
  {
    reservedAiTests = 0,
    actualAiTests = 0,
    audits = 0,
    monitoringRuns = 0,
  } = {},
  now = new Date()
) {
  const period = await getOrCreateUsagePeriod(prisma, workspaceId, now);
  const reserved = Math.max(0, Number(reservedAiTests) || 0);
  const actual = Math.max(0, Number(actualAiTests) || 0);
  const auditN = Math.max(0, Number(audits) || 0);
  const monN = Math.max(0, Number(monitoringRuns) || 0);

  // Release reserved, then add actual committed usage in one statement
  await prisma.$executeRaw`
    UPDATE "UsagePeriod"
    SET
      "aiTestsReserved" = GREATEST(0, "aiTestsReserved" - ${reserved}),
      "aiTests" = "aiTests" + ${actual},
      "audits" = "audits" + ${auditN},
      "monitoringRuns" = "monitoringRuns" + ${monN},
      "updatedAt" = NOW()
    WHERE "id" = ${period.id}
  `;

  return prisma.usagePeriod.findUnique({ where: { id: period.id } });
}

/**
 * Release a reservation without committing (run skipped / failed before billable work).
 */
export async function releaseUsage(prisma, workspaceId, { reservedAiTests = 0 } = {}, now = new Date()) {
  const reserved = Math.max(0, Number(reservedAiTests) || 0);
  if (reserved === 0) {
    return getOrCreateUsagePeriod(prisma, workspaceId, now);
  }
  const period = await getOrCreateUsagePeriod(prisma, workspaceId, now);
  await prisma.$executeRaw`
    UPDATE "UsagePeriod"
    SET
      "aiTestsReserved" = GREATEST(0, "aiTestsReserved" - ${reserved}),
      "updatedAt" = NOW()
    WHERE "id" = ${period.id}
  `;
  return prisma.usagePeriod.findUnique({ where: { id: period.id } });
}

/**
 * Atomically increment usage counters (legacy helper — prefer reserve + commit).
 */
export async function consumeUsage(prisma, workspaceId, delta = {}, now = new Date()) {
  return commitUsage(
    prisma,
    workspaceId,
    {
      reservedAiTests: 0,
      actualAiTests: delta.aiTests || 0,
      audits: delta.audits || 0,
      monitoringRuns: delta.monitoringRuns || 0,
    },
    now
  );
}

/**
 * Snapshot usage for UI / status / preflight (includes reserved as effective load).
 */
export async function getUsageSnapshot(prisma, workspaceId, now = new Date()) {
  const period = await getOrCreateUsagePeriod(prisma, workspaceId, now);
  const reserved = period.aiTestsReserved || 0;
  return {
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    aiTests: period.aiTests,
    aiTestsReserved: reserved,
    /** Effective load for preflight (committed + in-flight holds). */
    aiTestsEffective: period.aiTests + reserved,
    audits: period.audits,
    monitoringRuns: period.monitoringRuns,
  };
}
