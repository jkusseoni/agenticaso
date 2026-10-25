/**
 * Pure recovery-admin policy evaluator. Policy data MUST be loaded from a
 * trusted server-side store; never pass user-provided role or scope claims.
 * This module does not authenticate a user or load production policy.
 */
export function isRecoveryAdminAuthorized(policy, { actorId, workspaceId, permission }) {
  if (typeof actorId !== "string" || !actorId.trim() ||
      typeof workspaceId !== "string" || !workspaceId.trim() ||
      !["visibility.recovery.hold", "visibility.recovery.read"].includes(permission)) {
    return false;
  }
  if (!policy || policy.actorId !== actorId || policy.enabled !== true ||
      !Array.isArray(policy.permissions) || !policy.permissions.includes(permission) ||
      !Array.isArray(policy.workspaceIds) || !policy.workspaceIds.includes(workspaceId)) {
    return false;
  }
  return true;
}

/**
 * Injected loader must read current privileges from a trusted server store.
 * No cache or client-provided policy is accepted by this adapter itself.
 */
export function createRecoveryAdminAuthorizer({ loadPolicy } = {}) {
  if (typeof loadPolicy !== "function") throw new TypeError("Trusted policy loader required");
  return async ({ actor, workspaceId, permission }) => {
    if (typeof actor?.id !== "string" || !actor.id.trim()) return false;
    const policy = await loadPolicy(actor.id);
    return isRecoveryAdminAuthorized(policy, {
      actorId: actor.id, workspaceId, permission,
    });
  };
}
