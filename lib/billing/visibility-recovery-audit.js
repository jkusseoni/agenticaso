import { prepareVisibilityRecoveryDecision } from "./visibility-recovery-decision.js";

/**
 * Append a non-executable HOLD review after checking the operation belongs
 * to the specified workspace. No billing state is changed.
 */
export async function recordVisibilityRecoveryHold(prisma, input) {
  if (!prisma?.$transaction) throw new TypeError("Prisma transaction required");
  const decision = prepareVisibilityRecoveryDecision({ ...input, decision: "hold" });
  return prisma.$transaction(async (tx) => {
    // Lock the operation row so a concurrent settlement/release cannot
    // change its state between review validation and audit insertion.
    const rows = await tx.$queryRaw`
      SELECT "workspaceId", "status"
      FROM "VisibilityUsageOperation"
      WHERE "id" = ${decision.operationId}
      FOR UPDATE
    `;
    const operation = rows[0];
    if (!operation || operation.workspaceId !== decision.workspaceId) {
      return { status: "not_found" };
    }
    if (operation.status !== "reserved") {
      return { status: "not_reserved" };
    }
    const review = await tx.visibilityRecoveryReview.create({
      data: {
        operationId: decision.operationId,
        workspaceId: decision.workspaceId,
        reviewerId: decision.reviewerId,
        decision: "hold",
        reason: decision.reason,
        evidence: [...decision.evidence],
      },
      select: { id: true, createdAt: true },
    });
    return { status: "recorded", review };
  });
}
