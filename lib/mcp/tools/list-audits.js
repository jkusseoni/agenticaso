import { isUnlimited } from "../../billing/plans.js";
import { listAuditsForUser } from "../../db/persist.js";
import { compactAuditListItem } from "../../db/shape-audit.js";
import { mcpToolError, mcpToolJson } from "./result.js";

export async function runListAuditsTool(ctx, args = {}) {
  const clerkUserId = ctx?.workspace?.clerkUserId;
  if (!clerkUserId || !ctx.db) {
    return mcpToolError({ error: "Unauthorized.", code: "UNAUTHORIZED" });
  }

  const histLimit = ctx.entitlements?.entitlements?.historicalAudits;
  const requested = args.limit != null ? Number(args.limit) : 20;
  const capped = isUnlimited(histLimit)
    ? Math.min(50, Math.max(1, requested || 20))
    : Math.min(requested || 20, Math.max(1, Number(histLimit) || 3));

  const websiteId = args.websiteId ? String(args.websiteId).trim() : undefined;
  const rows = await listAuditsForUser(ctx.db, {
    clerkUserId,
    websiteId,
    limit: capped,
  });

  return mcpToolJson({
    audits: (rows || []).map(compactAuditListItem),
    count: (rows || []).length,
    entitlementLimit: isUnlimited(histLimit) ? null : histLimit,
  });
}
