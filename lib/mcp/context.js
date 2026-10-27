/**
 * Map MCP credentials to workspace billing.
 */

import { loadBillingContext } from "../billing/gates.js";
import { toBillingStatusView } from "../billing/subscription.js";
import { resolveActiveApiKey } from "./keys.js";

/**
 * Map a verified MCP API key to workspace billing.
 *
 * @returns {Promise<null | {
 *   workspace: object,
 *   apiKey: object,
 *   billing: object,
 *   billingView: object
 * }>}
 */
export async function authenticateMcpApiKey(
  db,
  plaintext,
  { now = new Date() } = {}
) {
  const resolved = await resolveActiveApiKey(db, plaintext, { now });

  if (!resolved?.workspace?.id) {
    return null;
  }

  let workspace = resolved.workspace;

  if (typeof db.workspace?.findUnique === "function") {
    const full = await db.workspace.findUnique({
      where: {
        id: workspace.id,
      },
      include: {
        subscription: true,
        _count: {
          select: {
            websites: true,
          },
        },
      },
    });

    if (full) {
      workspace = full;
    }
  }

  const billing = await loadBillingContext(db, workspace, {
    clerkPaid: false,
  });

  const websiteCount = workspace._count?.websites ?? 0;

  let monitoringCount = 0;

  if (typeof db.monitoring?.count === "function") {
    monitoringCount = await db.monitoring.count({
      where: {
        website: {
          workspaceId: workspace.id,
        },
        active: true,
      },
    });
  }

  const billingView = toBillingStatusView({
    entitlements: billing.entitlements,
    usage: billing.usage,
    websiteCount,
    monitoringCount,
  });

  return {
    workspace,
    apiKey: resolved.apiKey,
    authType: "api_key",
    scopes: [],
    billing,
    billingView,
  };
}

/**
 * Map a verified Clerk OAuth identity to workspace billing.
 *
 * Token verification happens before this function is called.
 */
export async function authenticateMcpOAuth(
  db,
  { userId, scopes = [] } = {}
) {
  if (!userId) {
    return null;
  }

  const workspace = await db.workspace.findUnique({
    where: {
      clerkUserId: userId,
    },
    include: {
      subscription: true,
      _count: {
        select: {
          websites: true,
        },
      },
    },
  });

  if (!workspace?.id) {
    return null;
  }

  const billing = await loadBillingContext(db, workspace, {
    clerkPaid: false,
  });

  const websiteCount = workspace._count?.websites ?? 0;

  let monitoringCount = 0;

  if (typeof db.monitoring?.count === "function") {
    monitoringCount = await db.monitoring.count({
      where: {
        website: {
          workspaceId: workspace.id,
        },
        active: true,
      },
    });
  }

  const billingView = toBillingStatusView({
    entitlements: billing.entitlements,
    usage: billing.usage,
    websiteCount,
    monitoringCount,
  });

  return {
    workspace,
    apiKey: null,
    authType: "oauth",
    clerkUserId: userId,
    scopes: Array.isArray(scopes) ? scopes : [],
    billing,
    billingView,
  };
}