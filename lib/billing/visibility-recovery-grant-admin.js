/**
 * Private operator-only grant mutation primitive. Never expose through a
 * customer route. Caller must provide an independently verified operator.
 * The default is deny; no bootstrap administrator is created.
 */
const PERMISSIONS = new Set(["visibility.recovery.hold", "visibility.recovery.read"]);
export async function changeRecoveryAdminGrant(prisma, input, { authorizeOperator } = {}) {
  const { operatorId, targetActorId, workspaceIds, permissions, reason, action } = input ?? {};
  if (typeof operatorId !== "string" || !operatorId.trim() ||
      typeof targetActorId !== "string" || !targetActorId.trim() ||
      typeof reason !== "string" || !reason.trim() ||
      !["grant", "revoke"].includes(action) ||
      (action === "grant" && (!Array.isArray(workspaceIds) || !workspaceIds.length ||
        !workspaceIds.every(x => typeof x === "string" && x.trim()) ||
        !Array.isArray(permissions) || !permissions.length ||
        !permissions.every(x => PERMISSIONS.has(x))))) {
    throw new TypeError("Invalid recovery grant change");
  }
  if (typeof authorizeOperator !== "function" ||
      await authorizeOperator({ operatorId, action, targetActorId }) !== true) {
    throw new Error("Recovery grant operator authorization denied");
  }
  return prisma.$transaction(async tx => {
    // Serialize changes to a single grant and audit record in one transaction.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${targetActorId}, 921))::text AS "lockResult"`;
    const existing = await tx.visibilityRecoveryAdminGrant.findUnique({
      where: { actorId: targetActorId },
    });
    if (action === "revoke" && !existing) {
      throw new Error("Recovery grant not found");
    }
    const beforeState = existing ? {
      enabled: existing.enabled, permissions: existing.permissions,
      workspaceIds: existing.workspaceIds,
    } : null;
    const afterState = action === "revoke"
      ? { enabled: false, permissions: [], workspaceIds: [] }
      : { enabled: true, permissions: [...new Set(permissions)], workspaceIds: [...new Set(workspaceIds)] };
    await tx.visibilityRecoveryAdminGrant.upsert({
      where: { actorId: targetActorId },
      create: { actorId: targetActorId, ...afterState },
      update: afterState,
    });
    await tx.visibilityRecoveryGrantAudit.create({
      data: { targetActorId, operatorId, action, beforeState, afterState, reason },
    });
    return { status: action === "grant" ? "granted" : "revoked", targetActorId };
  });
}
