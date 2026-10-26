import { recordVisibilityRecoveryHold } from "./visibility-recovery-audit.js";

/**
 * Server-side authorization boundary for recovery HOLD records.
 * Actor must originate from a verified server session, never request JSON.
 * Authorization is injected by the application security layer.
 */
export async function recordAuthorizedVisibilityRecoveryHold(prisma, {
  actor, operationId, workspaceId, evidence, reason, decision = "hold",
}, { authorize, record = recordVisibilityRecoveryHold } = {}) {
  if (!actor || typeof authorize !== "function") {
    throw new Error("Verified actor and recovery authorization are required");
  }
  if (typeof actor.id !== "string" || !actor.id.trim()) {
    throw new Error("Verified reviewer identity is required");
  }
  if (typeof workspaceId !== "string" || !workspaceId.trim()) {
    throw new TypeError("Workspace is required");
  }
  const allowed = await authorize({ actor, workspaceId, permission: "visibility.recovery.hold" });
  if (allowed !== true) throw new Error("Recovery review access denied");
  return record(prisma, {
    operationId, workspaceId, reviewerId: actor.id, evidence, reason, decision,
  });
}
