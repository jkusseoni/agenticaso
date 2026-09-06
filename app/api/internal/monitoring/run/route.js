import { getPrisma, isDatabaseConfigured, assertDb } from "@/lib/db";
import { processDueMonitoring } from "@/lib/monitoring";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/internal/monitoring/run
 * Protected by CRON_SECRET — used by Vercel Cron.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 *    or x-cron-secret: <CRON_SECRET>
 */
export async function POST(req) {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      return Response.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
    }

    const auth = req.headers.get("authorization") || "";
    const headerSecret = req.headers.get("x-cron-secret") || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (bearer !== secret && headerSecret !== secret) {
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    }

    if (!isDatabaseConfigured()) {
      return Response.json({ error: "Database is not configured yet.", processed: 0 }, { status: 503 });
    }

    const db = assertDb(getPrisma());
    const url = new URL(req.url);
    const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit") || 5)));
    const result = await processDueMonitoring(db, { limit });
    return Response.json({ ok: true, ...result });
  } catch (e) {
    console.error("monitoring cron error:", e?.message || e);
    return Response.json({ error: "Monitoring run failed." }, { status: 500 });
  }
}
