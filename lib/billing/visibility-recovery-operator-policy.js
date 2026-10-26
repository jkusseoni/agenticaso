/**
 * Independent operator policy for server-controlled grant administration.
 * Configuration must come from a trusted deployment secret/configuration,
 * never from a request, Clerk public metadata, or the recovery grant table.
 * No default operators are provisioned.
 */
export function createRecoveryGrantOperatorAuthorizer({ operatorIds } = {}) {
  if (!Array.isArray(operatorIds) ||
      !operatorIds.every(id => typeof id === "string" && id.trim() && id === id.trim()) ||
      new Set(operatorIds).size !== operatorIds.length) {
    throw new TypeError("Trusted operator ID configuration required");
  }
  const trustedIds = new Set(operatorIds);
  return async ({ operator, action, targetActorId }) => {
    if (typeof operator?.id !== "string" || !operator.id.trim() ||
        typeof targetActorId !== "string" || !targetActorId.trim() ||
        !["grant", "revoke"].includes(action)) return false;
    // Prevent an operator from granting or revoking their own reviewer role.
    if (operator.id === targetActorId) return false;
    return trustedIds.has(operator.id);
  };
}
