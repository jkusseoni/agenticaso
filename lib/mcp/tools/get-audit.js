import { assertAuditOwnership } from "../../db/ownership.js";
import { compactAuditDetail } from "../../db/shape-audit.js";
import { mcpToolError, mcpToolJson } from "./result.js";

export async function runGetAuditTool(ctx, args = {}) {
  const clerkUserId = ctx?.workspace?.clerkUserId;
  const auditId = String(args.auditId || "").trim();
  if (!clerkUserId || !ctx.db) {
    return mcpToolError({ error: "Unauthorized.", code: "UNAUTHORIZED" });
  }
  if (!auditId) {
    return mcpToolError({ error: "auditId is required.", code: "VALIDATION" });
  }

  try {
    const audit = await assertAuditOwnership(ctx.db, { auditId, clerkUserId });
    const compact = compactAuditDetail(audit);
    return mcpToolJson(compact);
  } catch (e) {
    if (e?.code === "NOT_FOUND") {
      return mcpToolError({ error: "Not found.", code: "NOT_FOUND" });
    }
    throw e;
  }
}
