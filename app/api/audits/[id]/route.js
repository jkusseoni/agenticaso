import { getPrisma, isDatabaseConfigured, assertDb, assertAuditOwnership } from "@/lib/db";
import { requireClerkUser, mapDbError } from "@/lib/db/auth-gate";

export const runtime = "nodejs";

/**
 * GET /api/audits/:id — owned audit detail
 */
export async function GET(_req, ctx) {
  try {
    const gate = await requireClerkUser();
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

    return Response.json({
      audit: {
        id: audit.id,
        websiteId: audit.websiteId,
        website: {
          id: audit.website.id,
          domain: audit.website.domain,
          brandName: audit.website.brandName,
          url: audit.website.url,
          category: audit.website.category,
        },
        status: audit.status,
        startedAt: audit.startedAt,
        completedAt: audit.completedAt,
        mentionShare: audit.mentionShare,
        recommendationShare: audit.recommendationShare,
        top3Share: audit.top3Share,
        providerMetrics: audit.providerMetrics,
        agenticScore: {
          found: { score: audit.foundScore, status: audit.foundStatus },
          understood: { score: audit.understoodScore, status: audit.understoodStatus },
          recommended: { score: audit.recommendedScore, status: audit.recommendedStatus },
          bought: { score: audit.boughtScore, status: audit.boughtStatus },
          overall: { score: audit.overallScore, status: audit.overallStatus },
        },
        intelligenceSummary: audit.intelligenceSummary,
        questions: (audit.questions || []).map((aq) => ({
          id: aq.question.id,
          question: aq.question.question,
          category: aq.question.category,
          sortOrder: aq.sortOrder,
        })),
        aiTests: (audit.aiTests || []).map((t) => ({
          id: t.id,
          provider: t.provider,
          model: t.model,
          question: t.question,
          brandMentioned: t.brandMentioned,
          recommended: t.recommended,
          position: t.position,
          competitors: t.competitors,
          citations: t.citations,
          confidence: t.confidence,
          latencyMs: t.latencyMs,
          error: t.error,
          storeAnswer: t.storeAnswer,
          // answer omitted from list detail by default for privacy; include flag
          hasAnswer: Boolean(t.answer),
          createdAt: t.createdAt,
        })),
        competitors: audit.competitors,
        perception: audit.perception,
      },
    });
  } catch (e) {
    return mapDbError(e);
  }
}
