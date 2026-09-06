import {
  getPrisma,
  isDatabaseConfigured,
  assertDb,
  assertAuditOwnership,
} from "@/lib/db";
import { requireClerkUser, mapDbError } from "@/lib/db/auth-gate";
import { diagnoseAudit } from "@/lib/ai/diagnosis";
import { shapeOwnedAudit } from "@/lib/db/shape-audit";

export const runtime = "nodejs";

/**
 * GET /api/audits/:id/diagnosis
 * Evidence-based issues from stored audit signals only.
 * Advanced diagnosis (full issue set) requires Pro+; Free gets a limited preview.
 */
export async function GET(_req, ctx) {
  try {
    const gate = await requireClerkUser({ withBilling: true });
    if (!gate.ok) return gate.response;
    if (!isDatabaseConfigured()) {
      return Response.json({ error: "Database is not configured yet." }, { status: 503 });
    }

    const { id } = await ctx.params;
    if (!id) return Response.json({ error: "Missing audit id." }, { status: 422 });

    const db = assertDb(getPrisma());
    const audit = await assertAuditOwnership(db, {
      auditId: id,
      clerkUserId: gate.userId,
    });

    const detail = shapeOwnedAudit(audit);
    const diagnosis = diagnoseAudit(detail);
    const advanced = gate.entitlements?.entitlements?.advancedDiagnosis === true;

    if (!advanced) {
      const issues = (diagnosis.issues || []).slice(0, 2);
      return Response.json({
        ...diagnosis,
        issues,
        limited: true,
        upgrade: {
          message: "Unlock full evidence-based diagnosis and fixes with Pro.",
          suggestedPlan: "pro",
        },
      });
    }

    return Response.json(diagnosis);
  } catch (e) {
    return mapDbError(e);
  }
}
