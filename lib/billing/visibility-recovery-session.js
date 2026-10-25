import { recordAuthorizedVisibilityRecoveryHold } from "./visibility-recovery-authorized.js";

/**
 * Trusted server-only entrypoint. Identity is obtained from an injected
 * verified-session resolver, never from request payload.
 * No HTTP route or production activation is provided here.
 */
export async function recordSessionVisibilityRecoveryHold(prisma, input, {
  resolveVerifiedActor, authorize, record,
} = {}) {
  if (typeof resolveVerifiedActor !== "function" || typeof authorize !== "function") {
    throw new Error("Verified session resolver and authorizer are required");
  }
  const actor = await resolveVerifiedActor();
  const { operationId, workspaceId, evidence, reason, decision } = input ?? {};
  return recordAuthorizedVisibilityRecoveryHold(prisma, {
    actor, operationId, workspaceId, evidence, reason, decision,
  }, { authorize, ...(record ? { record } : {}) });
}
