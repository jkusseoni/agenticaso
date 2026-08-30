/**
 * Shared Clerk gate for audit APIs.
 * Derives identity + entitlements server-side — never trusts client plan/status.
 */
import { auth, clerkClient } from "@clerk/nextjs/server";
import { getPrisma, isDatabaseConfigured } from "./prisma.js";
import { getOrCreateWorkspace } from "./ownership.js";
import {
  getEntitlements,
  loadBillingContext,
  toBillingStatusView,
} from "@/lib/billing";

/**
 * @returns {Promise<{
 *   ok: true,
 *   userId: string,
 *   email: string|null,
 *   isPaid: boolean,
 *   clerkPaid: boolean,
 *   workspace?: object,
 *   entitlements?: object,
 *   usage?: object,
 *   billing?: object,
 *   prisma?: import("@prisma/client").PrismaClient|null
 * } | { ok: false, response: Response }>}
 */
export async function requireClerkUser({
  requirePaid = false,
  withBilling = false,
} = {}) {
  const { userId } = await auth();
  if (!userId) {
    return {
      ok: false,
      response: Response.json({ error: "Please sign in." }, { status: 401 }),
    };
  }

  let email = null;
  let clerkPaid = false;
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    email = user?.primaryEmailAddress?.emailAddress || user?.emailAddresses?.[0]?.emailAddress || null;
    // Clerk publicMetadata.paid is never an entitlement source (login / email verify).
    clerkPaid = user?.publicMetadata?.paid === true;
  } catch {
    /* still allow auth if Clerk metadata fetch fails for read endpoints */
  }

  let workspace = null;
  let entitlements = getEntitlements(null);
  let usage = null;
  let billing = null;
  let prisma = null;

  if ((withBilling || requirePaid) && isDatabaseConfigured()) {
    try {
      prisma = getPrisma();
      if (prisma) {
        workspace = await getOrCreateWorkspace(prisma, { clerkUserId: userId, email });
        const full = await prisma.workspace.findUnique({
          where: { id: workspace.id },
          include: {
            subscription: true,
            _count: { select: { websites: true } },
          },
        });
        const ctx = await loadBillingContext(prisma, full);
        entitlements = ctx.entitlements;
        usage = ctx.usage;
        workspace = full || workspace;

        const monitoringCount = await prisma.monitoring.count({
          where: { website: { workspaceId: workspace.id }, active: true },
        });
        billing = toBillingStatusView({
          entitlements,
          usage,
          websiteCount: full?._count?.websites ?? 0,
          monitoringCount,
        });
      }
    } catch (e) {
      console.error("billing context load failed:", e?.message || e);
      entitlements = getEntitlements(null);
    }
  } else {
    entitlements = getEntitlements(null);
  }

  const isPaid = entitlements.isPaid === true;

  if (requirePaid && !isPaid) {
    return {
      ok: false,
      response: Response.json(
        {
          error: "This is a Pro feature. Upgrade to unlock.",
          upgrade: true,
          code: "ENTITLEMENT_REQUIRED",
          suggestedPlan: "pro",
          message: "Upgrade to Pro to unlock this feature.",
        },
        { status: 402 }
      ),
    };
  }

  return {
    ok: true,
    userId,
    email,
    isPaid,
    clerkPaid,
    workspace,
    entitlements,
    usage,
    billing,
    prisma,
  };
}

export function mapDbError(e) {
  if (e?.code === "DB_NOT_CONFIGURED") {
    return Response.json({ error: "Database is not configured yet." }, { status: 503 });
  }
  if (e?.code === "NOT_FOUND") {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  if (e?.code === "UNAUTHORIZED") {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (e?.code === "VALIDATION") {
    return Response.json({ error: "Invalid request." }, { status: 422 });
  }
  console.error("db api error:", e?.message || e);
  return Response.json({ error: "Request failed." }, { status: 500 });
}
