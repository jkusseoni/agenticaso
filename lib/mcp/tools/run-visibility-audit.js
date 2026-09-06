import { validateStoreUrl } from "../../ai/audit.js";
import { runVisibilityAuditV2 } from "../../ai/visibility-v2.js";
import { compactVisibilityAuditResult } from "../../db/shape-audit.js";
import { MCP_AUDIT_ACTION, MCP_AUDIT_PER_HOUR, consumeMcpRateLimit } from "../rate-limit.js";
import { withMcpConversion } from "../upgrade.js";
import { mcpToolError, mcpToolJson } from "./result.js";

/**
 * MCP run_visibility_audit — compact result only. Billing comes from the API-key workspace.
 */
export async function runVisibilityAuditTool(ctx, args = {}) {
  const clerkUserId = ctx?.workspace?.clerkUserId;
  if (!clerkUserId || !ctx.db) {
    return mcpToolError({ error: "Unauthorized.", code: "UNAUTHORIZED" });
  }

  const validated = validateStoreUrl(args.url);
  if (!validated.ok) {
    return mcpToolError({ error: validated.error, code: "INVALID_URL" });
  }

  const workspaceId = ctx.workspace.id;
  const auditLimit = ctx.auditLimit != null ? ctx.auditLimit : MCP_AUDIT_PER_HOUR;
  const rate = await consumeMcpRateLimit(ctx.db, {
    workspaceId,
    action: MCP_AUDIT_ACTION,
    limit: auditLimit,
    now: ctx.now || new Date(),
  });
  if (!rate.ok) {
    return mcpToolError({
      error: "Rate limit hit — try later.",
      code: "RATE_LIMIT",
      limit: rate.limit,
      used: rate.used,
      retryAt: rate.retryAt,
    });
  }

  const result = await runVisibilityAuditV2(
    {
      url: args.url,
      brand: args.brand,
      question: args.question,
      questions: args.questions,
      entitlements: ctx.entitlements,
      usage: ctx.billing?.usage,
      workspace: ctx.workspace,
      prisma: ctx.db,
      clerkUserId,
      email: ctx.workspace?.email || null,
      now: ctx.now,
    },
    ctx.visibilityAudit || {}
  );

  if (!result.ok) {
    const body = { ...(result.body || {}), error: result.body?.error || result.body?.message || "Audit failed." };
    if (result.status === 422) body.code = body.code || "INVALID_URL";
    else if (result.status === 402) {
      Object.assign(
        body,
        withMcpConversion(result.body, {
          siteUrl: ctx.siteUrl,
          campaign: "run_visibility_audit",
          billingView: ctx.billingView,
          planId: ctx.entitlements?.planId,
        })
      );
      body.code = body.code || "ENTITLEMENT_REQUIRED";
    } else body.code = body.code || "AUDIT_FAILED";
    return mcpToolError(body);
  }

  const advanced = ctx.entitlements?.entitlements?.advancedCompetitors === true;
  return mcpToolJson(compactVisibilityAuditResult(result.payload, { advancedCompetitors: advanced }));
}
