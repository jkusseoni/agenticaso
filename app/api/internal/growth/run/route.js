/**
 * POST /api/internal/growth/run
 *
 * Internal Growth worker. Disabled unless GROWTH_AGENT_ENABLED=true.
 * Auth: Authorization: Bearer <GROWTH_CRON_SECRET || CRON_SECRET>
 *    or x-cron-secret / x-growth-cron-secret.
 * Reuses CRON_SECRET when GROWTH_CRON_SECRET is unset (same convention as monitoring).
 * Not registered in vercel.json cron.
 */
import { getPrisma, isDatabaseConfigured, assertDb } from "@/lib/db";
import { handleGrowthInternalRun, runGrowthWorker } from "@/lib/growth/internal-run";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req) {
  return handleGrowthInternalRun(req, {
    env: process.env,
    getDb: () => (isDatabaseConfigured() ? assertDb(getPrisma()) : null),
    run: runGrowthWorker,
  });
}
