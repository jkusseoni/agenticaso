import { diagnoseAudit } from "../../ai/diagnosis/diagnose.js";
import { upgradePayload } from "../../billing/entitlements.js";
import { assertAuditOwnership } from "../../db/ownership.js";
import { shapeOwnedAudit } from "../../db/shape-audit.js";
import { withMcpConversion } from "../upgrade.js";
import { mcpToolError, mcpToolJson } from "./result.js";

const FREE_ISSUE_PREVIEW = 2;

export async function runDiagnoseAuditTool(ctx, args = {}) {
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
    const detail = shapeOwnedAudit(audit);
    const diagnosis = diagnoseAudit(detail);
    const advanced = ctx.entitlements?.entitlements?.advancedDiagnosis === true;

    if (!advanced) {
      const issues = (diagnosis.issues || []).slice(0, FREE_ISSUE_PREVIEW);
      return mcpToolJson({
        auditId: diagnosis.auditId,
        issues,
        summary: diagnosis.summary,
        limited: true,
        upgrade: withMcpConversion(
          upgradePayload({
            planId: ctx.entitlements?.planId,
            feature: "advancedDiagnosis",
            message: "Unlock full evidence-based diagnosis and fixes with Pro.",
          }),
          {
            siteUrl: ctx.siteUrl,
            campaign: "diagnose_audit",
            billingView: ctx.billingView,
            planId: ctx.entitlements?.planId,
          }
        ),
      });
    }

    return mcpToolJson({
      auditId: diagnosis.auditId,
      issues: diagnosis.issues || [],
      summary: diagnosis.summary,
      limited: false,
    });
  } catch (e) {
    if (e?.code === "NOT_FOUND") {
      return mcpToolError({ error: "Not found.", code: "NOT_FOUND" });
    }
    throw e;
  }
}
