/**
 * Read-only inspection of potentially abandoned Visibility reservations.
 *
 * Never release automatically: provider calls may have completed, and a
 * settlement response may have been lost. An operator must reconcile the
 * provider evidence and operation state before taking action.
 */
export async function listStaleVisibilityReservations(prisma, {
  olderThan = new Date(Date.now() - 60 * 60 * 1000),
  take = 100,
} = {}) {
  if (!prisma?.visibilityUsageOperation?.findMany ||
      !(olderThan instanceof Date) || !Number.isFinite(olderThan.getTime()) ||
      !Number.isSafeInteger(take) || take < 1 || take > 500) {
    throw new TypeError("Invalid visibility reservation inspection request");
  }
  return prisma.visibilityUsageOperation.findMany({
    where: { status: "reserved", createdAt: { lt: olderThan } },
    select: {
      id: true, workspaceId: true, usagePeriodId: true,
      reservedAiTests: true, createdAt: true, updatedAt: true,
    },
    orderBy: { createdAt: "asc" },
    take,
  });
}

/**
 * Read-only reconciliation preview for one operation. No provider evidence is
 * stored in this ledger, so a reserved operation requires manual investigation.
 * This deliberately does not call release or settlement.
 */
export async function inspectVisibilityOperation(prisma, { operationId, workspaceId }) {
  if (!prisma?.visibilityUsageOperation?.findUnique ||
      typeof operationId !== "string" || !operationId ||
      typeof workspaceId !== "string" || !workspaceId) {
    throw new TypeError("Invalid visibility operation inspection request");
  }
  const operation = await prisma.visibilityUsageOperation.findUnique({
    where: { id: operationId },
    select: {
      id: true, workspaceId: true, usagePeriodId: true,
      reservedAiTests: true, actualAiTests: true, status: true,
      createdAt: true, updatedAt: true,
    },
  });
  if (!operation || operation.workspaceId !== workspaceId) {
    return { status: "not_found", action: "none" };
  }
  if (operation.status === "reserved") {
    return { status: "reserved", action: "manual_review", operation };
  }
  if (operation.status === "committed" || operation.status === "released") {
    return { status: operation.status, action: "none", operation };
  }
  return { status: "unknown", action: "manual_review", operation };
}
