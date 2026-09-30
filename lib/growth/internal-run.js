/**
 * HTTP handler for POST /api/internal/growth/run (testable without Next aliases).
 */
import { safeSecretEqual } from "../security/secrets.js";
import { runGrowthWorker, getGrowthCronSecret, resolveGrowthWorkerLimit } from "./worker.js";

export { runGrowthWorker, getGrowthCronSecret, resolveGrowthWorkerLimit };

export async function handleGrowthInternalRun(req, deps = {}) {
  const env = deps.env || process.env;
  const secret = getGrowthCronSecret(env);
  if (!secret) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const auth = req.headers.get("authorization") || "";
  const headerSecret = req.headers.get("x-growth-cron-secret") || req.headers.get("x-cron-secret") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!safeSecretEqual(bearer, secret) && !safeSecretEqual(headerSecret, secret)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  if (String(env.GROWTH_AGENT_ENABLED || "") !== "true") {
    return Response.json({
      ok: true,
      enabled: false,
      examined: 0,
      claimed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      timedOut: 0,
      results: [],
    });
  }

  const getDb = deps.getDb;
  const db = typeof getDb === "function" ? getDb() : null;
  if (!db) {
    return Response.json({ error: "Database is not configured yet.", enabled: true, processed: 0 }, { status: 503 });
  }

  const url = new URL(req.url);
  const limit = resolveGrowthWorkerLimit(url.searchParams.get("limit") || env.GROWTH_WORKER_LIMIT);
  try {
    const run = deps.run || runGrowthWorker;
    const result = await run(db, {
      env,
      limit,
      fetchFn: deps.fetchFn,
      chatFn: deps.chatFn,
    });
    return Response.json({ ok: true, ...sanitizeWorkerResponse(result) });
  } catch (e) {
    console.error("growth worker error:", String(e?.message || e).slice(0, 200));
    return Response.json({ error: "Growth run failed." }, { status: 500 });
  }
}

function sanitizeWorkerResponse(result) {
  const results = Array.isArray(result.results)
    ? result.results.slice(0, 20).map((row) => ({
        jobId: row.jobId,
        type: row.type,
        status: row.status,
        ...(row.skip ? { skip: String(row.skip).slice(0, 80) } : {}),
        ...(row.errorCode ? { errorCode: String(row.errorCode).slice(0, 80) } : {}),
      }))
    : [];
  return {
    enabled: Boolean(result.enabled),
    examined: Number(result.examined) || 0,
    claimed: Number(result.claimed) || 0,
    succeeded: Number(result.succeeded) || 0,
    failed: Number(result.failed) || 0,
    skipped: Number(result.skipped) || 0,
    timedOut: Number(result.timedOut) || 0,
    results,
  };
}
