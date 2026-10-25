/**
 * Read-only review history scoped to the owning workspace.
 * The workspace constraint is applied in SQL, not filtered after retrieval.
 */
export async function listVisibilityRecoveryReviews(prisma, {
  operationId, workspaceId, take = 50,
}) {
  if (!prisma?.visibilityRecoveryReview?.findMany ||
      typeof operationId !== "string" || !operationId.trim() ||
      typeof workspaceId !== "string" || !workspaceId.trim() ||
      !Number.isSafeInteger(take) || take < 1 || take > 100) {
    throw new TypeError("Invalid visibility review history request");
  }
  return prisma.visibilityRecoveryReview.findMany({
    where: { operationId, workspaceId, operation: { workspaceId } },
    select: {
      id: true, operationId: true, workspaceId: true,
      reviewerId: true, decision: true, reason: true,
      evidence: true, createdAt: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
  });
}
