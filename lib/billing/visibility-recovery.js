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
