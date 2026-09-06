import {
  getPrisma,
  isDatabaseConfigured,
  assertDb,
  listAuditsForUser,
  persistCompletedAudit,
  getPreviousCompletedAudit,
} from "@/lib/db";
import { requireClerkUser, mapDbError } from "@/lib/db/auth-gate";
import { isUnlimited } from "@/lib/billing";

export const runtime = "nodejs";

/**
 * GET /api/audits — list current user's audits
 * Query: ?websiteId=&limit=
 * Free plans are capped by historicalAudits entitlement.
 */
export async function GET(req) {
  try {
    const gate = await requireClerkUser({ withBilling: true });
    if (!gate.ok) return gate.response;
    if (!isDatabaseConfigured()) {
      return Response.json({ error: "Database is not configured yet.", audits: [] }, { status: 503 });
    }

    const db = assertDb(getPrisma());
    const url = new URL(req.url);
    const websiteId = url.searchParams.get("websiteId") || undefined;
    const requested = Number(url.searchParams.get("limit") || 20);
    const histLimit = gate.entitlements?.entitlements?.historicalAudits;
    const capped = isUnlimited(histLimit)
      ? requested
      : Math.min(requested, Math.max(1, Number(histLimit) || 3));

    const audits = await listAuditsForUser(db, {
      clerkUserId: gate.userId,
      websiteId,
      limit: capped,
    });

    return Response.json({
      audits: audits.map((a) => ({
        id: a.id,
        websiteId: a.websiteId,
        website: a.website,
        status: a.status,
        startedAt: a.startedAt,
        completedAt: a.completedAt,
        mentionShare: a.mentionShare,
        recommendationShare: a.recommendationShare,
        top3Share: a.top3Share,
        overallScore: a.overallScore,
        overallStatus: a.overallStatus,
        providerMetrics: a.providerMetrics,
        topCompetitors: a.competitors,
      })),
      entitlementLimit: isUnlimited(histLimit) ? null : histLimit,
    });
  } catch (e) {
    return mapDbError(e);
  }
}

/**
 * POST /api/audits — optionally persist a client-supplied v2 payload.
 * Prefer automatic persistence from /api/visibility/v2.
 * Body: { v2Payload: object }
 */
export async function POST(req) {
  try {
    const gate = await requireClerkUser({ withBilling: true });
    if (!gate.ok) return gate.response;
    if (!isDatabaseConfigured()) {
      return Response.json({ error: "Database is not configured yet." }, { status: 503 });
    }

    const body = await req.json().catch(() => ({}));
    const v2Payload = body.v2Payload;
    if (!v2Payload || typeof v2Payload !== "object") {
      return Response.json({ error: "Send { v2Payload } from a completed visibility v2 run." }, { status: 422 });
    }

    const db = assertDb(getPrisma());
    const saved = await persistCompletedAudit(db, {
      clerkUserId: gate.userId,
      email: gate.email,
      v2Payload,
    });

    const previous = await getPreviousCompletedAudit(db, saved.website.id, {
      excludeAuditId: saved.audit.id,
    });

    return Response.json({
      ok: true,
      auditId: saved.audit.id,
      websiteId: saved.website.id,
      previousAuditId: previous?.id || null,
    });
  } catch (e) {
    return mapDbError(e);
  }
}
