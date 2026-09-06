import {
  getPrisma,
  isDatabaseConfigured,
  assertDb,
  assertAuditOwnership,
} from "@/lib/db";
import { requireClerkUser, mapDbError } from "@/lib/db/auth-gate";
import { requireEntitlement } from "@/lib/billing";

export const runtime = "nodejs";

/**
 * GET /api/audits/:id/export — JSON export (entitlement-gated).
 */
export async function GET(_req, ctx) {
  try {
    const gate = await requireClerkUser({ withBilling: true });
    if (!gate.ok) return gate.response;

    const { rateLimited } = await import("@/lib/api/rate-limit");
    if (rateLimited(`${gate.userId}:export`, 30)) {
      return Response.json({ error: "Rate limit hit — try later." }, { status: 429 });
    }

    const entitlement = requireEntitlement(gate, "exports");
    // exports may be number (0) or unlimited null — treat falsy 0 as denied
    const plan = gate.entitlements?.entitlements;
    if (!plan || plan.exports === 0 || plan.exports === false) {
      return Response.json(
        {
          upgrade: true,
          code: "ENTITLEMENT_REQUIRED",
          feature: "exports",
          message: "Exports are available on Pro. Upgrade to download audit data.",
          suggestedPlan: "pro",
        },
        { status: 402 }
      );
    }

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

    return Response.json({
      exportedAt: new Date().toISOString(),
      audit: {
        id: audit.id,
        websiteId: audit.websiteId,
        domain: audit.website?.domain,
        brandName: audit.website?.brandName,
        status: audit.status,
        completedAt: audit.completedAt,
        mentionShare: audit.mentionShare,
        recommendationShare: audit.recommendationShare,
        top3Share: audit.top3Share,
        overallScore: audit.overallScore,
        providerMetrics: audit.providerMetrics,
        competitors: audit.competitors,
        perception: audit.perception,
      },
    });
  } catch (e) {
    return mapDbError(e);
  }
}
