import { recordSessionVisibilityRecoveryHold } from "./visibility-recovery-session.js";
import { createRecoveryAdminAuthorizer } from "./visibility-recovery-rbac.js";

/**
 * Server-only Clerk adapter. This function is NOT an API endpoint.
 * loadPolicy must retrieve current grants from trusted server-controlled storage.
 * No client-provided actor, role, reviewerId, or policy is accepted.
 */
export async function recordClerkVisibilityRecoveryHold(prisma, input, {
  loadPolicy,
  getAuth,
  record,
} = {}) {
  if (typeof loadPolicy !== "function") {
    throw new TypeError("Trusted recovery admin policy loader required");
  }
  // Defer Clerk import to runtime: node:test cannot resolve Clerk Next.js internals.
  // Only trusted server code should call this adapter.
  const resolveAuth = getAuth ?? (async () => {
    const { auth } = await import("@clerk/nextjs/server");
    return auth();
  });
  if (typeof resolveAuth !== "function") {
    throw new TypeError("Clerk server auth resolver required");
  }
  return recordSessionVisibilityRecoveryHold(prisma, input, {
    resolveVerifiedActor: async () => {
      const session = await resolveAuth();
      const userId = session?.userId;
      if (typeof userId !== "string" || !userId.trim()) {
        throw new Error("Recovery admin authentication required");
      }
      return { id: userId };
    },
    authorize: createRecoveryAdminAuthorizer({ loadPolicy }),
    ...(record ? { record } : {}),
  });
}
