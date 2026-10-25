/**
 * Read-only server-side policy loader. Grant provisioning/revocation must be
 * restricted to a separately authenticated and audited operator process.
 */
export function createPrismaRecoveryAdminPolicyLoader(prisma) {
  if (typeof prisma?.visibilityRecoveryAdminGrant?.findUnique !== "function") {
    throw new TypeError("Recovery admin grant database required");
  }
  return async (actorId) => {
    if (typeof actorId !== "string" || !actorId.trim()) return null;
    const grant = await prisma.visibilityRecoveryAdminGrant.findUnique({
      where: { actorId },
      select: {
        actorId: true, enabled: true, permissions: true, workspaceIds: true,
      },
    });
    return grant ?? null;
  };
}
