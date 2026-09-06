import {
  getPrisma,
  isDatabaseConfigured,
  assertDb,
  assertAuditOwnership,
  compareAudits,
} from "@/lib/db";
import { requireClerkUser, mapDbError } from "@/lib/db/auth-gate";

export const runtime = "nodejs";

/**
 * GET /api/audits/:id/compare/:previousId
 * Both audits must belong to the authenticated user.
 */
export async function GET(_req, ctx) {
  try {
    const gate = await requireClerkUser();
    if (!gate.ok) return gate.response;
    if (!isDatabaseConfigured()) {
      return Response.json({ error: "Database is not configured yet." }, { status: 503 });
    }

    const { id, previousId } = await ctx.params;
    if (!id || !previousId) {
      return Response.json({ error: "Missing audit ids." }, { status: 422 });
    }

    const db = assertDb(getPrisma());
    const current = await assertAuditOwnership(db, { auditId: id, clerkUserId: gate.userId });
    const previous = await assertAuditOwnership(db, {
      auditId: previousId,
      clerkUserId: gate.userId,
    });

    if (current.websiteId !== previous.websiteId) {
      return Response.json(
        { error: "Audits must belong to the same website for comparison." },
        { status: 422 }
      );
    }

    const comparison = compareAudits(
      { ...current, competitors: current.competitors },
      { ...previous, competitors: previous.competitors }
    );

    return Response.json({
      comparison,
      providerMovement: comparison.delta?.providers || null,
      competitorMovement: comparison.delta?.competitors || [],
    });
  } catch (e) {
    return mapDbError(e);
  }
}
