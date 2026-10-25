import { recordClerkVisibilityRecoveryHold } from "./visibility-recovery-clerk.js";
import { createPrismaRecoveryAdminPolicyLoader } from "./visibility-recovery-policy-store.js";

/**
 * Server-only composition for recovery HOLD. No HTTP endpoint or grant writer.
 * Prisma grants are authoritative; session identity comes from Clerk server auth.
 */
export async function recordDatabaseAuthorizedRecoveryHold(prisma, input, {
  getAuth,
  record,
} = {}) {
  const loadPolicy = createPrismaRecoveryAdminPolicyLoader(prisma);
  return recordClerkVisibilityRecoveryHold(prisma, input, {
    loadPolicy,
    ...(getAuth !== undefined ? { getAuth } : {}),
    ...(record ? { record } : {}),
  });
}
