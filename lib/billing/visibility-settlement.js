/**
 * Durable visibility settlement. This module is intentionally not wired into the
 * request handler until reservation and concurrency integration tests are in place.
 *
 * All mutations happen in one database transaction. The operation ID is an
 * idempotency key; retrying settlement cannot increment aggregate usage twice.
 */
export async function settleVisibilityOperation(prisma, {
  operationId,
  workspaceId,
  actualAiTests,
}) {
  if (typeof operationId !== "string" || !operationId || typeof workspaceId !== "string" || !workspaceId ||
      !Number.isSafeInteger(actualAiTests) || actualAiTests < 0) {
    throw new TypeError("Invalid visibility settlement request");
  }

  return prisma.$transaction(async (tx) => {
    // Lock the operation before examining its status; concurrent commits and
    // releases must serialize on the same row.
    const locked = await tx.$queryRaw`
      SELECT "id", "workspaceId", "usagePeriodId", "reservedAiTests",
             "actualAiTests", "status"
      FROM "VisibilityUsageOperation"
      WHERE "id" = ${operationId}
      FOR UPDATE
    `;
    const op = locked[0];
    if (!op || op.workspaceId !== workspaceId) {
      return { status: "not_found" };
    }
    if (actualAiTests > op.reservedAiTests) {
      return { status: "invalid_amount" };
    }
    if (op.status === "committed") {
      return op.actualAiTests === actualAiTests
        ? { status: "already_committed" }
        : { status: "amount_conflict" };
    }
    if (op.status !== "reserved") {
      return { status: "already_released" };
    }

    // The row lock ensures this is applied at most once for this operation ID.
    // The usage period update and status change commit or roll back together.
    const updated = await tx.$executeRaw`
      UPDATE "UsagePeriod"
      SET "aiTestsReserved" = "aiTestsReserved" - ${op.reservedAiTests},
          "aiTests" = "aiTests" + ${actualAiTests},
          "updatedAt" = NOW()
      WHERE "id" = ${op.usagePeriodId}
        AND "workspaceId" = ${workspaceId}
        AND "aiTestsReserved" >= ${op.reservedAiTests}
    `;
    if (Number(updated) !== 1) {
      throw new Error("Visibility reservation accounting mismatch");
    }
    await tx.visibilityUsageOperation.update({
      where: { id: operationId },
      data: { status: "committed", actualAiTests },
    });
    return { status: "committed" };
  });
}
