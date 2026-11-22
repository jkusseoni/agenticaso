import { randomUUID } from "node:crypto";
import { isUnlimited } from "./plans.js";
import { getOrCreateUsagePeriod } from "./usage.js";
export async function reserveUsageOperation(
  prisma,
  workspaceId,
  { aiTests = 0, limit = null, createOperationForZeroUsage = false } = {},
  now = new Date()
) {
  const need = aiTests;
  if (!Number.isSafeInteger(need) || need < 0 || need > 2147483647) {
    throw new RangeError("aiTests must be a nonnegative safe integer");
  }
  const max = isUnlimited(limit) ? null : limit;
  if (
    max !== null &&
    (!Number.isSafeInteger(max) || max < 0 || max > 2147483647)
  ) {
    throw new RangeError("Invalid AI test allowance");
  }
  if (need === 0 && !createOperationForZeroUsage) {
    return { ok: true, operationId: null, reserved: 0 };
  }
  const operationId = randomUUID();
  return prisma.$transaction(async (tx) => {
    const period = await getOrCreateUsagePeriod(
      tx,
      workspaceId,
      now
    );
    const updated = await tx.$executeRaw`
      UPDATE "UsagePeriod"
      SET
        "aiTestsReserved" = "aiTestsReserved" + ${need},
        "updatedAt" = NOW()
      WHERE "id" = ${period.id}
        AND "aiTestsReserved" <= (2147483647 - ${need})
        AND (
          ${max}::integer IS NULL
          OR ("aiTests"::bigint + "aiTestsReserved"::bigint + ${need})
             <= ${max}::bigint
        )
    `;
    if (Number(updated) !== 1) {
      return {
        ok: false,
        reason: "insufficient_allowance",
        limit: max,
        need,
      };
    }
    await tx.$executeRaw`
      INSERT INTO "VisibilityUsageOperation" (
        "id",
        "workspaceId",
        "usagePeriodId",
        "reservedAiTests",
        "actualAiTests",
        "status",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${operationId},
        ${workspaceId},
        ${period.id},
        ${need},
        NULL,
        'reserved',
        NOW(),
        NOW()
      )
    `;
    return {
      ok: true,
      operationId,
      reserved: need,
      periodId: period.id,
    };
  });
}/**
 * Commit a reservation exactly once.
 *
 * The operation transition and usage counter update share one transaction.
 * Duplicate or conflicting settlements return settled:false.
 */
export async function commitUsageOperationInTransaction(
  tx,
  workspaceId,
  {
    operationId,
    actualAiTests = 0,
    audits = 0,
    monitoringRuns = 0,
  } = {}
) {
  if (typeof operationId !== "string" || !operationId.trim()) {
    throw new TypeError("operationId is required");
  }
  for (const value of [actualAiTests, audits, monitoringRuns]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) {
      throw new RangeError("Settlement amounts must be nonnegative integers");
    }
  }
  return (async () => {
    const rows = await tx.$queryRaw`
      UPDATE "VisibilityUsageOperation"
      SET
        "status" = 'committed',
        "actualAiTests" = ${actualAiTests},
        "updatedAt" = NOW()
      WHERE "id" = ${operationId}
        AND "workspaceId" = ${workspaceId}
        AND "status" = 'reserved'
        AND "reservedAiTests" >= ${actualAiTests}
      RETURNING "usagePeriodId", "reservedAiTests"
    `;
    if (rows.length !== 1) {
      return { settled: false };
    }
    const operation = rows[0];
    const updated = await tx.$executeRaw`
      UPDATE "UsagePeriod"
      SET
        "aiTestsReserved" =
          "aiTestsReserved" - ${operation.reservedAiTests},
        "aiTests" = "aiTests" + ${actualAiTests},
        "audits" = "audits" + ${audits},
        "monitoringRuns" = "monitoringRuns" + ${monitoringRuns},
        "updatedAt" = NOW()
      WHERE "id" = ${operation.usagePeriodId}
        AND "workspaceId" = ${workspaceId}
        AND "aiTestsReserved" >= ${operation.reservedAiTests}
        AND "aiTests" <= (2147483647 - ${actualAiTests})
        AND "audits" <= (2147483647 - ${audits})
        AND "monitoringRuns" <= (2147483647 - ${monitoringRuns})
    `;
    if (Number(updated) !== 1) {
      throw new Error("Usage counter settlement invariant failed");
    }
    return {
      settled: true,
      operationId,
      actualAiTests,
    };
  })();
}
/**
 * Release a reservation exactly once.
 */

export async function commitUsageOperation(prisma, workspaceId, amounts = {}) {
  return prisma.$transaction((tx) =>
    commitUsageOperationInTransaction(tx, workspaceId, amounts)
  );
}
export async function releaseUsageOperation(
  prisma,
  workspaceId,
  { operationId } = {}
) {
  if (typeof operationId !== "string" || !operationId.trim()) {
    throw new TypeError("operationId is required");
  }
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`
      UPDATE "VisibilityUsageOperation"
      SET
        "status" = 'released',
        "updatedAt" = NOW()
      WHERE "id" = ${operationId}
        AND "workspaceId" = ${workspaceId}
        AND "status" = 'reserved'
      RETURNING "usagePeriodId", "reservedAiTests"
    `;
    if (rows.length !== 1) {
      return { settled: false };
    }
    const operation = rows[0];
    const updated = await tx.$executeRaw`
      UPDATE "UsagePeriod"
      SET
        "aiTestsReserved" =
          "aiTestsReserved" - ${operation.reservedAiTests},
        "updatedAt" = NOW()
      WHERE "id" = ${operation.usagePeriodId}
        AND "workspaceId" = ${workspaceId}
        AND "aiTestsReserved" >= ${operation.reservedAiTests}
    `;
    if (Number(updated) !== 1) {
      throw new Error("Usage counter release invariant failed");
    }
    return {
      settled: true,
      operationId,
    };
  });
}


export async function getUsageOperationStatus(prisma, workspaceId, operationId) {
  if (!workspaceId || !operationId) throw new Error("Missing billing operation identity");
  const rows = await prisma.$queryRaw`
    SELECT "status" FROM "VisibilityUsageOperation"
    WHERE "id" = ${operationId} AND "workspaceId" = ${workspaceId}
    LIMIT 1
  `;
  return rows.length === 1 ? rows[0].status : null;
}
