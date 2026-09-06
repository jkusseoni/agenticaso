import {
  getPrisma,
  isDatabaseConfigured,
  assertDb,
  assertAuditOwnership,
} from "@/lib/db";
import { requireClerkUser, mapDbError } from "@/lib/db/auth-gate";
import { shapeOwnedAudit } from "@/lib/db/shape-audit";
import { diagnoseAudit, generateFix } from "@/lib/ai/diagnosis";
import { generateAuditFixes, persistIssueFix, publicFix } from "@/lib/ai/generate-fix";
import { requireEntitlement } from "@/lib/billing";

export const runtime = "nodejs";

/**
 * GET /api/audits/:id/fixes
 * List persisted Action Engine snippets for an owned audit (Pro).
 */
export async function GET(_req, ctx) {
  try {
    const gate = await requireClerkUser({ withBilling: true });
    if (!gate.ok) return gate.response;

    const entitlement = requireEntitlement(gate, "advancedDiagnosis");
    if (!entitlement.ok) return entitlement.response;

    if (!isDatabaseConfigured()) {
      return Response.json({ error: "Database is not configured yet." }, { status: 503 });
    }

    const { id } = await ctx.params;
    if (!id) return Response.json({ error: "Missing audit id." }, { status: 422 });

    const db = assertDb(getPrisma());
    await assertAuditOwnership(db, {
      auditId: id,
      clerkUserId: gate.userId,
    });

    const rows = await db.fix.findMany({
      where: { auditId: id },
      orderBy: { createdAt: "asc" },
    });
    return Response.json({ fixes: rows.map(publicFix) });
  } catch (e) {
    return mapDbError(e);
  }
}

/**
 * POST /api/audits/:id/fixes
 * - { issueId } → per-issue narrative fix (dashboard Generate Fix). Also persisted when possible.
 * - {} → generate and persist the Action Engine pack (JSON-LD, llms.txt, FAQ, meta).
 * Workspace id is taken from the owned audit, never from the client body.
 */
export async function POST(req, ctx) {
  try {
    const gate = await requireClerkUser({ withBilling: true });
    if (!gate.ok) return gate.response;

    const { rateLimited } = await import("@/lib/api/rate-limit");
    if (rateLimited(`${gate.userId}:fixes`, 40)) {
      return Response.json({ error: "Rate limit hit — try later." }, { status: 429 });
    }

    const entitlement = requireEntitlement(gate, "advancedDiagnosis");
    if (!entitlement.ok) return entitlement.response;

    if (!isDatabaseConfigured()) {
      return Response.json({ error: "Database is not configured yet." }, { status: 503 });
    }

    const { id } = await ctx.params;
    if (!id) return Response.json({ error: "Missing audit id." }, { status: 422 });

    const body = await req.json().catch(() => ({}));
    const issueId = String(body.issueId || "").trim();

    const db = assertDb(getPrisma());
    const auditRow = await assertAuditOwnership(db, {
      auditId: id,
      clerkUserId: gate.userId,
    });

    const workspaceId = auditRow.website?.workspaceId;
    if (!workspaceId) {
      return Response.json({ error: "Audit workspace is missing." }, { status: 422 });
    }

    const audit = shapeOwnedAudit(auditRow);
    const diagnosis = diagnoseAudit(audit);

    if (!issueId) {
      const created = await generateAuditFixes({
        prisma: db,
        auditId: id,
        workspaceId,
        audit,
        diagnosisData: diagnosis,
      });
      return Response.json({ success: true, fixes: created.map(publicFix) });
    }

    const issue = (diagnosis.issues || []).find((i) => i.id === issueId);
    if (!issue) {
      return Response.json({ error: "Issue not found for this audit." }, { status: 404 });
    }

    const fix = generateFix(issue, audit);
    try {
      await persistIssueFix({ prisma: db, auditId: id, workspaceId, issue, audit });
    } catch (persistErr) {
      console.error("Persist issue fix:", persistErr?.code || persistErr?.message);
    }
    return Response.json({ issueId, fix });
  } catch (e) {
    return mapDbError(e);
  }
}
