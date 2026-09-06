import { buildIntelligence } from "../ai/intelligence/index.js";
import { runMultiAiAudit } from "../ai/audit.js";
import { persistCompletedAudit, getPreviousCompletedAudit } from "../db/persist.js";
import { diagnoseAudit } from "../ai/diagnosis/index.js";
import { buildMonitoringAlerts } from "./alerts.js";
import { ALERT_TYPES } from "./thresholds.js";
import { scheduleKeyFor, computeNextRunAt } from "./schedule.js";
import { prepareMonitoringUsage } from "../billing/monitoring-prepare.js";
import { commitUsage, releaseUsage, countBillableAiTests } from "../billing/index.js";

/** Stale "running" lock timeout (distributed-safe via DB timestamps). */
export const MONITORING_STALE_MS = 15 * 60 * 1000;

/**
 * True if every provider result across all questions has an error (or no results).
 * @param {Array<{ providers?: Array<{ error?: string|null }> }>} byQuestion
 */
export function allProvidersFailed(byQuestion) {
  const results = [];
  for (const row of byQuestion || []) {
    for (const p of row.providers || []) results.push(p);
  }
  if (!results.length) return true;
  return results.every((p) => Boolean(p?.error));
}

/**
 * Build weekly report payload (email-ready later).
 */
export function buildWeeklyReportData({ website, currentAudit, previousAudit, alerts = [], issues = [] }) {
  const period = {
    from: previousAudit?.completedAt || null,
    to: currentAudit?.completedAt || null,
  };

  const highlights = (alerts || [])
    .filter((a) => a.severity === "info" || a.type === "visibility_rise" || a.type === "gap_shrinking")
    .map((a) => a.title);

  const risks = (alerts || [])
    .filter((a) => a.severity === "high" || a.severity === "critical" || a.severity === "medium")
    .map((a) => a.title);

  const providerMovement = {};
  for (const id of ["openai", "perplexity", "gemini"]) {
    const c = currentAudit?.providerMetrics?.[id];
    const p = previousAudit?.providerMetrics?.[id];
    providerMovement[id] = {
      previous: p?.recommendationShare ?? null,
      current: c?.recommendationShare ?? null,
      delta:
        c?.recommendationShare != null && p?.recommendationShare != null
          ? Math.round((c.recommendationShare - p.recommendationShare) * 10) / 10
          : null,
    };
  }

  const competitorMovement = (alerts || [])
    .filter((a) =>
      ["competitor_overtake", "gap_widening", "gap_shrinking", "new_competitor"].includes(a.type)
    )
    .map((a) => ({ title: a.title, type: a.type, data: a.data }));

  return {
    website: website
      ? { id: website.id, domain: website.domain, brandName: website.brandName, url: website.url }
      : null,
    period,
    currentAudit: currentAudit
      ? {
          id: currentAudit.id,
          mentionShare: currentAudit.mentionShare,
          recommendationShare: currentAudit.recommendationShare,
          top3Share: currentAudit.top3Share,
          overallScore: currentAudit.overallScore,
          completedAt: currentAudit.completedAt,
        }
      : null,
    previousAudit: previousAudit
      ? {
          id: previousAudit.id,
          mentionShare: previousAudit.mentionShare,
          recommendationShare: previousAudit.recommendationShare,
          top3Share: previousAudit.top3Share,
          overallScore: previousAudit.overallScore,
          completedAt: previousAudit.completedAt,
        }
      : null,
    highlights,
    risks,
    providerMovement,
    competitorMovement,
    recommendedActions: (issues || []).slice(0, 5).map((i) => ({
      id: i.id,
      priority: i.priority,
      title: i.title,
    })),
  };
}

/**
 * Atomic claim for cron or Run Now. Prevents concurrent execution on the same monitor.
 * Uses DB as source of truth (safe across Vercel instances).
 *
 * @returns {Promise<{ claimed: true } | { claimed: false, reason: string }>}
 */
export async function claimMonitoringExecution(db, monitoring, { scheduleKey, manual = false, staleMs = MONITORING_STALE_MS } = {}) {
  const staleBefore = new Date(Date.now() - staleMs);

  const notRunningOrStale = {
    OR: [
      { lastStatus: { not: "running" } },
      { lastStatus: null },
      { lastRunAt: { lt: staleBefore } },
      { lastRunAt: null },
    ],
  };

  const where = {
    id: monitoring.id,
    active: true,
    AND: [
      notRunningOrStale,
      ...(manual ? [] : [{ NOT: { lastScheduleKey: scheduleKey } }]),
    ],
  };

  const result = await db.monitoring.updateMany({
    where,
    data: {
      lastScheduleKey: scheduleKey,
      lastStatus: "running",
      lastError: null,
      lastRunAt: new Date(),
    },
  });

  if (result.count === 1) return { claimed: true };

  let current = null;
  try {
    current = await db.monitoring.findUnique({ where: { id: monitoring.id } });
  } catch {
    current = null;
  }
  if (!manual && current?.lastScheduleKey === scheduleKey && current?.lastStatus !== "running") {
    return { claimed: false, reason: "skipped_idempotent" };
  }
  if (current?.lastStatus === "running") {
    return { claimed: false, reason: "already_running" };
  }
  return { claimed: false, reason: manual ? "already_running" : "skipped_idempotent" };
}

/** @deprecated use claimMonitoringExecution */
export async function claimMonitoringRun(db, monitoring, scheduleKey) {
  const r = await claimMonitoringExecution(db, monitoring, { scheduleKey, manual: false });
  return r.claimed;
}

async function markSkipped(db, monitoring, frequency, status, message, { advanceSchedule = true } = {}) {
  await db.monitoring.update({
    where: { id: monitoring.id },
    data: {
      lastStatus: status,
      lastError: String(message || "").slice(0, 500),
      lastRunAt: new Date(),
      ...(advanceSchedule ? { nextRunAt: computeNextRunAt(frequency) } : {}),
    },
  });
}

/**
 * Execute one monitoring run using existing multi-AI + persistence stack.
 * Shared path for cron and Run Now — entitlement + usage reservation before AI calls.
 *
 * @param {import("@prisma/client").PrismaClient} db
 * @param {object} monitoring — includes website.workspace (+ subscription preferred)
 * @param {{ manual?: boolean, scheduleKey?: string }} [opts]
 */
export async function executeMonitoringRun(db, monitoring, opts = {}) {
  const website = monitoring.website;
  if (!website) {
    return { ok: false, status: "error", reason: "Website missing on monitoring record." };
  }

  const clerkUserId = website.workspace?.clerkUserId;
  if (!clerkUserId) {
    return { ok: false, status: "error", reason: "Workspace ownership missing." };
  }

  // Load subscription for entitlement (cron path may not include it)
  if (website.workspace?.id && !website.workspace.subscription) {
    const fullWs = await db.workspace.findUnique({
      where: { id: website.workspace.id },
      include: { subscription: true },
    });
    if (fullWs) website.workspace = fullWs;
  }

  const frequency = monitoring.frequency || "weekly";
  const scheduleKey =
    opts.scheduleKey ||
    (opts.manual ? `manual:${monitoring.id}:${Date.now()}` : scheduleKeyFor(frequency));

  // 1) Entitlement + usage preflight + atomic reserve (BEFORE claim / AI)
  const prep = await prepareMonitoringUsage(db, monitoring);

  if (!prep.ok) {
    const advance = prep.status !== "error";
    // Keep monitoring active; record useful status; no misleading alerts
    if (prep.status === "skipped_entitlement" || prep.status === "skipped_usage" || prep.status === "skipped") {
      await markSkipped(db, monitoring, frequency, prep.status, prep.reason, {
        advanceSchedule: !opts.manual && advance,
      });
      return {
        ok: false,
        status: prep.status,
        reason: prep.reason,
        upgrade: prep.upgrade || null,
        expectedAiTests: prep.expectedAiTests,
      };
    }
    await markSkipped(db, monitoring, frequency, "error", prep.reason, { advanceSchedule: !opts.manual });
    return { ok: false, status: "error", reason: prep.reason };
  }

  const { questions, expectedAiTests, reserved, workspaceId } = prep;

  // 2) Concurrency claim (DB lock)
  const claim = await claimMonitoringExecution(db, monitoring, {
    scheduleKey,
    manual: Boolean(opts.manual),
  });

  if (!claim.claimed) {
    await releaseUsage(db, workspaceId, { reservedAiTests: reserved });
    return {
      ok: claim.reason === "skipped_idempotent",
      status: claim.reason,
      reason:
        claim.reason === "already_running"
          ? "A monitoring run is already in progress for this website."
          : "Already processed for this schedule window.",
    };
  }

  const startedAt = new Date();
  let byQuestion;
  try {
    const auditRun = await runMultiAiAudit({
      brandName: website.brandName || website.domain.split(".")[0],
      websiteUrl: website.url,
      domain: website.domain,
      questions: questions.map((q) => q.question),
      category: website.category || "",
    });
    byQuestion = auditRun.byQuestion;
  } catch (e) {
    await releaseUsage(db, workspaceId, { reservedAiTests: reserved });
    await finishFailed(db, monitoring, frequency, e?.message || "Multi-AI audit failed", opts.manual);
    return { ok: false, status: "failed", reason: e?.message || "Multi-AI audit failed" };
  }

  if (allProvidersFailed(byQuestion)) {
    // No successful billable tests — release reservation, do not commit fake usage
    await releaseUsage(db, workspaceId, { reservedAiTests: reserved });
    await finishFailed(db, monitoring, frequency, "All AI providers failed; no successful audit created.", opts.manual);
    await db.alert.create({
      data: {
        websiteId: website.id,
        monitoringId: monitoring.id,
        type: ALERT_TYPES.RUN_FAILED,
        severity: "high",
        title: "Monitoring run failed — all AI providers errored",
        description: "OpenAI, Perplexity, and Gemini all failed. Monitoring stays active for the next schedule.",
        data: { scheduleKey },
      },
    });
    return { ok: false, status: "failed", reason: "All AI providers failed.", aiTestsCharged: 0 };
  }

  const billable = countBillableAiTests({ byQuestion });

  const intelligence = buildIntelligence({
    brandName: website.brandName || website.domain.split(".")[0],
    byQuestion,
    category: website.category || "",
    whatTheySell: "",
    siteContext: { reachable: true },
    buyerQuestions: questions.map((q) => q.question),
  });

  const v2Payload = {
    version: 2,
    domain: website.domain,
    brand: website.brandName || website.domain.split(".")[0],
    category: website.category || "",
    websiteUrl: website.url,
    queriesRun: questions.length,
    byQuestion,
    intelligence,
  };

  const previous = await getPreviousCompletedAudit(db, website.id);
  const saved = await persistCompletedAudit(db, {
    clerkUserId,
    email: website.workspace?.email || null,
    v2Payload,
    startedAt,
  });

  await commitUsage(db, workspaceId, {
    reservedAiTests: reserved,
    actualAiTests: billable,
    audits: 1,
    monitoringRuns: 1,
  });

  const current = saved.audit;
  const alertRows = buildMonitoringAlerts({
    current: {
      ...current,
      competitors: current.competitors,
      perception: current.perception,
      providerMetrics: current.providerMetrics,
    },
    previous,
    websiteId: website.id,
    auditId: current.id,
    monitoringId: monitoring.id,
  });

  if (alertRows.length) {
    await db.alert.createMany({ data: alertRows });
  }

  const diagnosis = diagnoseAudit({
    id: current.id,
    website: {
      domain: website.domain,
      brandName: website.brandName,
      category: website.category,
      url: website.url,
    },
    mentionShare: current.mentionShare,
    recommendationShare: current.recommendationShare,
    top3Share: current.top3Share,
    providerMetrics: current.providerMetrics,
    agenticScore: {
      found: { score: current.foundScore, status: current.foundStatus },
      understood: { score: current.understoodScore, status: current.understoodStatus },
      recommended: { score: current.recommendedScore, status: current.recommendedStatus },
      bought: { score: current.boughtScore, status: current.boughtStatus },
      overall: { score: current.overallScore, status: current.overallStatus },
    },
    intelligenceSummary: current.intelligenceSummary,
    competitors: current.competitors,
    perception: current.perception,
    questions: questions.map((q) => ({ id: q.id, question: q.question, category: q.category })),
    aiTests: current.aiTests,
  });

  const report = buildWeeklyReportData({
    website,
    currentAudit: current,
    previousAudit: previous,
    alerts: alertRows,
    issues: diagnosis.issues,
  });

  await db.monitoring.update({
    where: { id: monitoring.id },
    data: {
      lastStatus: "completed",
      lastError: null,
      lastRunAt: new Date(),
      ...(opts.manual ? {} : { nextRunAt: computeNextRunAt(frequency) }),
    },
  });

  return {
    ok: true,
    status: "completed",
    auditId: current.id,
    alertsCreated: alertRows.length,
    report,
    previousAuditId: previous?.id || null,
    aiTestsCharged: billable,
    expectedAiTests,
  };
}

async function finishFailed(db, monitoring, frequency, message, manual = false) {
  await db.monitoring.update({
    where: { id: monitoring.id },
    data: {
      lastStatus: "failed",
      lastError: String(message).slice(0, 500),
      lastRunAt: new Date(),
      ...(manual ? {} : { nextRunAt: computeNextRunAt(frequency) }),
    },
  });
}

/**
 * Process all due monitoring records (cron).
 */
export async function processDueMonitoring(db, { limit = 10, now = new Date() } = {}) {
  const due = await db.monitoring.findMany({
    where: {
      active: true,
      nextRunAt: { lte: now },
    },
    take: limit,
    orderBy: { nextRunAt: "asc" },
    include: {
      website: { include: { workspace: { include: { subscription: true } } } },
    },
  });

  const results = [];
  for (const m of due) {
    try {
      const r = await executeMonitoringRun(db, m, { manual: false });
      results.push({ monitoringId: m.id, websiteId: m.websiteId, ...r });
    } catch (e) {
      console.error("processDueMonitoring item error:", e?.message || e);
      results.push({
        monitoringId: m.id,
        websiteId: m.websiteId,
        ok: false,
        status: "error",
        reason: "Monitoring run failed.",
      });
    }
  }
  return { processed: results.length, results };
}
