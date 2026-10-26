import { changeRecoveryAdminGrant } from "./visibility-recovery-grant-admin.js";

/**
 * Server-only authenticated operator boundary. No HTTP endpoint is provided.
 * resolveVerifiedOperator must derive identity from the trusted server session.
 * authorizeOperator must use an independently administered policy source.
 */
export async function changeSessionRecoveryAdminGrant(prisma, input, {
  resolveVerifiedOperator,
  authorizeOperator,
  change = changeRecoveryAdminGrant,
} = {}) {
  if (typeof resolveVerifiedOperator !== "function" ||
      typeof authorizeOperator !== "function" ||
      typeof change !== "function") {
    throw new TypeError("Verified operator session, authorizer and grant change required");
  }
  const operator = await resolveVerifiedOperator();
  if (typeof operator?.id !== "string" || !operator.id.trim()) {
    throw new Error("Recovery grant operator authentication required");
  }
  // Explicitly whitelist fields: caller-supplied operatorId and role are ignored.
  const { targetActorId, workspaceIds, permissions, reason, action } = input ?? {};
  return change(prisma, {
    operatorId: operator.id, targetActorId, workspaceIds, permissions, reason, action,
  }, {
    authorizeOperator: async ({ operatorId, action, targetActorId }) => {
      if (operatorId !== operator.id) return false;
      return await authorizeOperator({ operator, action, targetActorId }) === true;
    },
  });
}
