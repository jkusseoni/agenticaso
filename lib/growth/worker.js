/**
 * Bounded internal Growth worker. Processes existing due jobs only.
 * Disabled unless GROWTH_AGENT_ENABLED=true. No discovery or outreach.
 *
 * Auth for the HTTP route reuses CRON_SECRET unless GROWTH_CRON_SECRET is set.
 * Commercial Growth entitlements are not implemented; local AI budget still applies.
 */

import { processGrowthJob, GROWTH_AI_TIMEOUT_MS, GROWTH_AI_BUDGET } from "./orchestrator.js";
import { claimGrowthJob } from "./job-claim.js";
import { GROWTH_ERROR_CODES } from "./persist-run.js";

export const GROWTH_WORKER_BATCH_DEFAULT = 3;
export const GROWTH_WORKER_BATCH_HARD_MAX = 5;
export const GROWTH_WORKER_SELECT_CAP = 20;
export const GROWTH_WORKER_BUDGET_MS = Math.max(
  5_000,
  Number(process.env.GROWTH_WORKER_BUDGET_MS) || 50_000
);
export const GROWTH_WORKER_SAFETY_MARGIN_MS = 5_000;

const RETRYABLE_CRITIC_CODES = new Set(["CRITIC_TIMEOUT"]);
const TERMINAL_PROSPECTS = new Set(["qualified", "rejected", "failed"]);
const ACTIVE_CAMPAIGN = "active";

export function resolveGrowthWorkerLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return GROWTH_WORKER_BATCH_DEFAULT;
  return Math.min(GROWTH_WORKER_BATCH_HARD_MAX, Math.max(1, Math.floor(n)));
}

export function isGrowthAgentEnabled(env = process.env) {
  return String(env.GROWTH_AGENT_ENABLED || "") === "true";
}

export function parseWorkspaceAllowlist(env = process.env) {
  const raw = String(env.GROWTH_WORKSPACE_ALLOWLIST || "").trim();
  if (!raw) return null;
  return new Set(raw.split(/[\s,]+/).filter(Boolean));
}

export function getGrowthCronSecret(env = process.env) {
  return String(env.GROWTH_CRON_SECRET || env.CRON_SECRET || "");
}

export function remainingWorkerMs(startedAt, now, budgetMs = GROWTH_WORKER_BUDGET_MS) {
  return budgetMs - (now - startedAt);
}

export function canStartAiStage(remainingMs, timeoutMs = GROWTH_AI_TIMEOUT_MS) {
  return remainingMs > timeoutMs + GROWTH_WORKER_SAFETY_MARGIN_MS;
}

/**
 * @returns {Promise<object>}
 */
export async function runGrowthWorker(db, opts = {}) {
  const env = opts.env || process.env;
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now());
  const startedAt = opts.startedAt || now.getTime();
  const clock = typeof opts.clock === "function" ? opts.clock : () => Date.now();
  const budgetMs = Number.isFinite(opts.budgetMs) ? opts.budgetMs : GROWTH_WORKER_BUDGET_MS;
  const limit = resolveGrowthWorkerLimit(opts.limit ?? env.GROWTH_WORKER_LIMIT);
  const processJob = typeof opts.processJob === "function" ? opts.processJob : processGrowthJob;
  const allowlist = parseWorkspaceAllowlist(env);

  const empty = {
    enabled: false,
    examined: 0,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    timedOut: 0,
    results: [],
  };

  if (!isGrowthAgentEnabled(env)) {
    return empty;
  }

  const summary = {
    enabled: true,
    examined: 0,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    timedOut: 0,
    results: [],
  };

  await enqueueRetryableCriticJobs(db, { now, limit, allowlist });

  const candidates = await db.growthJob.findMany({
    where: {
      OR: [
        { status: "pending", availableAt: { lte: now } },
        { status: "running", leaseExpiresAt: { lte: now } },
      ],
    },
    orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
    take: Math.min(GROWTH_WORKER_SELECT_CAP, Math.max(limit * 4, limit)),
  });

  summary.examined = candidates.length;
  let started = 0;

  for (const job of candidates) {
    if (started >= limit) break;
    const remaining = remainingWorkerMs(startedAt, clock(), budgetMs);
    if (remaining <= GROWTH_WORKER_SAFETY_MARGIN_MS) {
      summary.timedOut += 1;
      summary.results.push(safeResult(job, "timed_out"));
      break;
    }
    if ((job.type === "qualify" || job.type === "critic") && !canStartAiStage(remaining, opts.aiTimeoutMs || GROWTH_AI_TIMEOUT_MS)) {
      summary.timedOut += 1;
      summary.results.push(safeResult(job, "timed_out"));
      break;
    }

    const campaign = await db.growthCampaign.findUnique({ where: { id: job.campaignId } });
    const prospect = job.prospectId
      ? await db.growthProspect.findUnique({ where: { id: job.prospectId } })
      : null;
    const skip = skipReason({ job, campaign, prospect, allowlist });
    if (skip) {
      summary.skipped += 1;
      summary.results.push(safeResult(job, "skipped", { skip }));
      continue;
    }

    const claim = await claimGrowthJob(db, job.id, { now: new Date(clock()), leaseMs: opts.leaseMs });
    if (claim.status !== "claimed") {
      summary.skipped += 1;
      summary.results.push(safeResult(job, "skipped", { skip: claim.status }));
      continue;
    }

    started += 1;
    summary.claimed += 1;
    let outcome;
    try {
      outcome = await processJob({
        db,
        jobId: job.id,
        now: new Date(clock()),
        alreadyClaimed: true,
        fetchFn: opts.fetchFn,
        chatFn: opts.chatFn,
        detailedChatFn: opts.detailedChatFn,
      });
    } catch (err) {
      outcome = {
        status: "failed",
        errorCode: GROWTH_ERROR_CODES.PERSISTENCE_CONFLICT,
      };
      summary.failed += 1;
      summary.results.push(safeResult(job, "failed", { errorCode: outcome.errorCode }));
      continue;
    }
    const row = safeResult(job, outcome.status || "unknown", {
      errorCode: outcome.errorCode || null,
    });
    summary.results.push(row);
    if (outcome.status === "succeeded" || outcome.status === "already_complete") summary.succeeded += 1;
    else if (outcome.status === "failed") summary.failed += 1;
  }

  return summary;
}

export function skipReason({ job, campaign, prospect, allowlist }) {
  if (!campaign) return "missing_campaign";
  if (allowlist && !allowlist.has(campaign.workspaceId)) return "workspace_not_allowlisted";
  if (campaign.status !== ACTIVE_CAMPAIGN) return `campaign_${campaign.status}`;
  if (!prospect) return "missing_prospect";
  if (TERMINAL_PROSPECTS.has(prospect.lifecycleState)) return "terminal_prospect";
  if (prospect.lifecycleState === "needs_review" && job.type !== "critic") return "terminal_prospect";
  return null;
}

export async function enqueueRetryableCriticJobs(db, { now, limit, allowlist }) {
  const failed = await db.growthJob.findMany({
    where: {
      type: "critic",
      status: "failed",
      lastErrorCode: { in: [...RETRYABLE_CRITIC_CODES] },
    },
    orderBy: [{ createdAt: "asc" }],
    take: Math.min(GROWTH_WORKER_SELECT_CAP, limit * 2),
  });
  for (const job of failed) {
    const prospect = job.prospectId
      ? await db.growthProspect.findUnique({ where: { id: job.prospectId } })
      : null;
    const campaign = await db.growthCampaign.findUnique({ where: { id: job.campaignId } });
    if (!prospect || !campaign) continue;
    if (allowlist && !allowlist.has(campaign.workspaceId)) continue;
    if (campaign.status !== ACTIVE_CAMPAIGN) continue;
    if (!["needs_review", "qualifying"].includes(prospect.lifecycleState)) continue;

    const quals = await db.growthQualification.findFirst({
      where: { prospectId: prospect.id },
      orderBy: { createdAt: "desc" },
    });
    if (!quals) continue;
    const existingReview = await db.growthCriticReview.findUnique({
      where: { qualificationId: quals.id },
    });
    if (existingReview) continue;
    const open = await db.growthJob.findFirst({
      where: {
        prospectId: prospect.id,
        type: "critic",
        status: { in: ["pending", "running"] },
      },
    });
    if (open) continue;
    await db.growthJob.create({
      data: {
        campaignId: campaign.id,
        prospectId: prospect.id,
        type: "critic",
        status: "pending",
        availableAt: now,
      },
    });
  }
}

function safeResult(job, status, extra = {}) {
  const row = {
    jobId: job.id,
    type: job.type,
    status,
  };
  if (extra.skip) row.skip = String(extra.skip).slice(0, 80);
  if (extra.errorCode) row.errorCode = String(extra.errorCode).slice(0, 80);
  return row;
}

export { GROWTH_ERROR_CODES, GROWTH_AI_BUDGET };
