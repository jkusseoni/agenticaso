/**
 * Reserve a uniquely identified Visibility operation in one transaction.
 * Not wired into the handler until integration tests pass.
 */
export async function reserveVisibilityOperation(prisma, {
  operationId, workspaceId, aiTests, limit = null, now = new Date(),
}) {
  if (typeof operationId !== "string" || !operationId ||
      typeof workspaceId !== "string" || !workspaceId ||
      !Number.isSafeInteger(aiTests) || aiTests <= 0 ||
      !(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      (limit !== null && (!Number.isSafeInteger(limit) || limit < 0))) {
    throw new TypeError("Invalid visibility reservation request");
  }
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  return prisma.$transaction(async (tx) => {
    // Serialize same operation ID via PostgreSQL transaction advisory lock.
    // The lock is scoped to this transaction and never escapes the DB session.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${operationId}, 0))`;
    const existing = await tx.visibilityUsageOperation.findUnique({ where: { id: operationId } });
    if (existing) {
      if (existing.workspaceId !== workspaceId || existing.reservedAiTests !== aiTests ||
          existing.usagePeriodId == null) return { status: "conflict" };
      return { status: existing.status, operationId, reserved: existing.reservedAiTests };
    }
    const period = await tx.usagePeriod.upsert({
      where: { workspaceId_periodStart: { workspaceId, periodStart } },
      create: { workspaceId, periodStart, periodEnd, aiTests: 0, aiTestsReserved: 0, audits: 0, monitoringRuns: 0 },
      update: {},
    });
    const changed = limit === null
      ? await tx.usagePeriod.update({ where: { id: period.id }, data: { aiTestsReserved: { increment: aiTests } } }).then(() => 1)
      : await tx.$executeRaw`
          UPDATE "UsagePeriod"
          SET "aiTestsReserved" = "aiTestsReserved" + ${aiTests}, "updatedAt" = NOW()
          WHERE "id" = ${period.id}
            AND ("aiTests" + "aiTestsReserved" + ${aiTests}) <= ${limit}
        `;
    if (Number(changed) !== 1) return { status: "insufficient_allowance" };
    await tx.visibilityUsageOperation.create({
      data: { id: operationId, workspaceId, usagePeriodId: period.id, reservedAiTests: aiTests, status: "reserved" },
    });
    return { status: "reserved", operationId, reserved: aiTests };
  });
}

/**
 * Release only an unsettled operation; duplicate release is harmless.
 * Row locking serializes release against settleVisibilityOperation.
 */
export async function releaseVisibilityOperation(prisma, { operationId, workspaceId }) {
  if (typeof operationId !== "string" || !operationId ||
      typeof workspaceId !== "string" || !workspaceId) {
    throw new TypeError("Invalid visibility release request");
  }
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT "id", "workspaceId", "usagePeriodId", "reservedAiTests", "status"
      FROM "VisibilityUsageOperation" WHERE "id" = ${operationId} FOR UPDATE
    `;
    const op = rows[0];
    if (!op || op.workspaceId !== workspaceId) return { status: "not_found" };
    if (op.status !== "reserved") return { status: op.status };
    const updated = await tx.$executeRaw`
      UPDATE "UsagePeriod"
      SET "aiTestsReserved" = "aiTestsReserved" - ${op.reservedAiTests},
          "updatedAt" = NOW()
      WHERE "id" = ${op.usagePeriodId}
        AND "workspaceId" = ${workspaceId}
        AND "aiTestsReserved" >= ${op.reservedAiTests}
    `;
    if (Number(updated) !== 1) throw new Error("Visibility reservation accounting mismatch");
    await tx.visibilityUsageOperation.update({
      where: { id: operationId }, data: { status: "released" },
    });
    return { status: "released" };
  });
}
