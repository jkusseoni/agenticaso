import { auth } from "@clerk/nextjs/server";
import { recordSessionVisibilityRecoveryHold } from "./visibility-recovery-session.js";
import { createRecoveryAdminAuthorizer } from "./visibility-recovery-rbac.js";

/**
 * Server-only Clerk adapter. This function is NOT an API endpoint.
 * loadPolicy must retrieve current grants from trusted server-controlled storage.
 * No client-provided actor, role, reviewerId, or policy is accepted.
 */
export async function recordClerkVisibilityRecoveryHold(prisma, input, {
  loadPolicy,
  getAuth = auth,
  record,
} = {}) {
  if (typeof loadPolicy !== "function") {
    throw new TypeError("Trusted recovery admin policy loader required");
  }
  if (typeof getAuth !== "function") {
    throw new TypeError("Clerk server auth resolver required");
  }
  return recordSessionVisibilityRecoveryHold(prisma, input, {
    resolveVerifiedActor: async () => {
      const session = await getAuth();
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
