import { changeSessionRecoveryAdminGrant } from "./visibility-recovery-grant-session.js";

/**
 * Server-only Clerk identity adapter for trusted operator grant changes.
 * No public endpoint, default operator grant, or self-service bootstrap.
 * authorizeOperator MUST consult an independently administered source.
 */
export async function changeClerkRecoveryAdminGrant(prisma, input, {
  authorizeOperator, getAuth, change,
} = {}) {
  if (typeof authorizeOperator !== "function") {
    throw new TypeError("Independent recovery grant operator policy required");
  }
  const resolveAuth = getAuth === undefined ? (async () => {
    const { auth } = await import("@clerk/nextjs/server");
    return auth();
  }) : getAuth;
  if (typeof resolveAuth !== "function") {
    throw new TypeError("Clerk server auth resolver required");
  }
  return changeSessionRecoveryAdminGrant(prisma, input, {
    resolveVerifiedOperator: async () => {
      const session = await resolveAuth();
      if (typeof session?.userId !== "string" || !session.userId.trim()) {
        throw new Error("Recovery grant operator authentication required");
      }
      return { id: session.userId };
    },
    authorizeOperator,
    ...(change ? { change } : {}),
  });
}
