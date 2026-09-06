import { compareAudits } from "../db/compare.js";
import { PROVIDER_LABELS } from "./theme.js";

/**
 * Build historical trend points from audit list (oldest → newest).
 * Does not fabricate data.
 * @param {Array<object>} audits
 */
export function buildTrendSeries(audits) {
  const completed = (audits || [])
    .filter((a) => a && a.status === "completed")
    .slice()
    .sort((a, b) => new Date(a.completedAt || 0) - new Date(b.completedAt || 0));

  if (completed.length < 2) {
    return {
      available: false,
      points: completed.map(mapTrendPoint),
      message: "Run another audit to unlock visibility trends.",
    };
  }

  return {
    available: true,
    points: completed.map(mapTrendPoint),
    message: null,
  };
}

function mapTrendPoint(a) {
  const pm = a.providerMetrics || {};
  return {
    id: a.id,
    date: a.completedAt,
    overallScore: a.overallScore ?? null,
    mentionShare: a.mentionShare ?? null,
    recommendationShare: a.recommendationShare ?? null,
    openaiRec: pm.openai?.recommendationShare ?? null,
    perplexityRec: pm.perplexity?.recommendationShare ?? null,
    geminiRec: pm.gemini?.recommendationShare ?? null,
  };
}

/**
 * Provider cards from audit metrics + optional comparison delta.
 * Failed/missing providers stay visible with empty/error state — do not fail the view.
 */
export function buildProviderCards(audit, comparison = null) {
  const metrics = audit?.providerMetrics || {};
  const deltas = comparison?.delta?.providers || {};
  const tests = audit?.aiTests || [];

  return ["openai", "perplexity", "gemini"].map((id) => {
    const m = metrics[id] || {};
    const failedCount = tests.filter((t) => t.provider === id && t.error).length;
    const okCount = tests.filter((t) => t.provider === id && !t.error).length;
    const hasAny = okCount + failedCount > 0 || m.tests > 0;

    return {
      id,
      label: PROVIDER_LABELS[id] || id,
      mentionShare: m.mentionShare ?? null,
      recommendationShare: m.recommendationShare ?? null,
      top3Share: m.top3Share ?? null,
      tests: m.tests ?? okCount,
      partialFailure: failedCount > 0 && okCount > 0,
      failed: failedCount > 0 && okCount === 0,
      unavailable: !hasAny && m.mentionShare == null,
      delta: {
        mentionShare: deltas[id]?.mentionShare?.delta ?? null,
        recommendationShare: deltas[id]?.delta ?? deltas[id]?.recommendationShare?.delta ?? null,
        top3Share: deltas[id]?.top3Share?.delta ?? null,
      },
    };
  });
}

/**
 * Competitor view model: brand + top competitors with gap + evidence-only "why ahead".
 */
export function buildCompetitorView(audit, comparison = null) {
  const brand = audit?.website?.brandName || audit?.intelligenceSummary?.overall?.brand || "Your brand";
  const targetRec = audit?.recommendationShare ?? 0;
  const targetTop3 = audit?.top3Share ?? 0;
  const list = (audit?.competitors || []).slice().sort((a, b) => (b.recommendationShare ?? 0) - (a.recommendationShare ?? 0));
  const movement = comparison?.delta?.competitors || [];

  const rows = [
    {
      name: brand,
      isTarget: true,
      recommendationShare: targetRec,
      top3Share: targetTop3,
      gap: 0,
      movement: null,
      whyAhead: null,
    },
    ...list.slice(0, 5).map((c) => {
      const gap =
        c.recommendationShare != null
          ? Math.round((targetRec - c.recommendationShare) * 10) / 10
          : null;
      const mov = movement.find((m) => String(m.competitor).toLowerCase() === String(c.name).toLowerCase());
      return {
        name: c.name,
        isTarget: false,
        recommendationShare: c.recommendationShare ?? null,
        top3Share: c.top3Share ?? null,
        mentions: c.mentions ?? null,
        gap,
        movement: mov?.recommendationShareDelta ?? null,
        whyAhead: whyCompetitorAhead(c, audit?.perception, targetRec),
      };
    }),
  ];

  return { brand, rows, gapSummary: audit?.intelligenceSummary?.competitorGap || null };
}

/**
 * Evidence-only explanation — never invent unsupported claims.
 */
export function whyCompetitorAhead(competitor, perception, targetRec) {
  const reasons = [];
  if (competitor.recommendationShare != null && targetRec != null && competitor.recommendationShare > targetRec) {
    reasons.push(`Higher recommendation share (${competitor.recommendationShare}% vs ${targetRec}%).`);
  }
  if (competitor.top3Share != null && competitor.top3Share >= 50) {
    reasons.push(`Frequently appears in AI top-3 lists (${competitor.top3Share}%).`);
  }
  if ((competitor.mentions || 0) >= 3) {
    reasons.push(`Mentioned across multiple AI answers (×${competitor.mentions}).`);
  }
  if (competitor.averagePosition != null && competitor.averagePosition <= 2) {
    reasons.push(`Often ranked near #1 (avg position ${competitor.averagePosition}).`);
  }
  // Perception themes only if they exist — not claimed as competitor-specific without evidence
  const unexpected = perception?.unexpectedThemes || [];
  if (unexpected.length && competitor.recommendationShare > (targetRec || 0)) {
    reasons.push(`AI answers emphasize themes you may lack in positioning: ${unexpected.slice(0, 3).join(", ")}.`);
  }
  return reasons.length ? reasons : ["No additional evidence beyond share metrics."];
}

/**
 * Actionable fix list based ONLY on detected gaps.
 */
export function buildActionList(audit, comparison = null) {
  const actions = [];
  const agentic = audit?.agenticScore || {};
  const perception = audit?.perception || audit?.intelligenceSummary?.perception || {};
  const rec = audit?.recommendationShare ?? 0;
  const mention = audit?.mentionShare ?? 0;
  const top3 = audit?.top3Share ?? 0;
  const gap = audit?.intelligenceSummary?.competitorGap;

  if ((agentic.found?.status === "ok" && (agentic.found.score ?? 100) < 55) || agentic.found?.status === "not_evaluated") {
    if (agentic.found?.status === "ok") {
      actions.push({
        priority: "HIGH",
        title: "Improve AI discoverability",
        detail: "Found score is low — ensure AI crawlers are allowed and a sitemap is published.",
        evidence: `foundScore=${agentic.found.score}`,
      });
    }
  }

  if (agentic.understood?.status === "ok" && (agentic.understood.score ?? 100) < 60) {
    actions.push({
      priority: "MEDIUM",
      title: "Improve product/entity clarity",
      detail: "Add clearer product schema, llms.txt, and on-page descriptions so agents understand what you sell.",
      evidence: `understoodScore=${agentic.understood.score}`,
    });
  }

  if (rec < 25) {
    actions.push({
      priority: "HIGH",
      title: "Improve comparison content",
      detail: "AI assistants rarely recommend you. Publish comparison-ready pages and category guides buyers ask about.",
      evidence: `recommendationShare=${rec}%`,
    });
  } else if (rec < 50) {
    actions.push({
      priority: "MEDIUM",
      title: "Strengthen recommendation signals",
      detail: "You appear sometimes, but not often enough as the pick. Add proof points AI can cite.",
      evidence: `recommendationShare=${rec}%`,
    });
  }

  if (mention >= 30 && top3 < 20) {
    actions.push({
      priority: "MEDIUM",
      title: "Move from mentioned to ranked",
      detail: "You're mentioned but rarely in the top 3. Tighten differentiation in buyer-facing copy.",
      evidence: `mentionShare=${mention}%, top3Share=${top3}%`,
    });
  }

  if ((perception.missingThemes || []).length) {
    actions.push({
      priority: "MEDIUM",
      title: "Close perception gaps",
      detail: `Your positioning includes themes AI answers omit: ${(perception.missingThemes || []).slice(0, 4).join(", ")}.`,
      evidence: `missingThemes=${(perception.missingThemes || []).length}`,
    });
  }

  if (gap && gap.gap != null && gap.gap < -10 && gap.competitorName) {
    actions.push({
      priority: "HIGH",
      title: `Close gap vs ${gap.competitorName}`,
      detail: `You're ${Math.abs(gap.gap)} pp behind on recommendation share. Study how AI describes that competitor.`,
      evidence: `gap=${gap.gap}, competitor=${gap.competitorName}`,
    });
  }

  if (agentic.bought?.status === "not_evaluated") {
    actions.push({
      priority: "LOW",
      title: "Add commerce-readiness signals",
      detail: "Bought could not be evaluated. Expose offer/price feed or agent-checkout readiness when available.",
      evidence: "bought=not_evaluated",
    });
  }

  const providers = buildProviderCards(audit, comparison);
  const failed = providers.filter((p) => p.failed);
  if (failed.length) {
    actions.push({
      priority: "LOW",
      title: "Retry failed AI providers",
      detail: `${failed.map((p) => p.label).join(", ")} returned errors — fix API keys/config and rescan.`,
      evidence: `failedProviders=${failed.map((p) => p.id).join(",")}`,
    });
  }

  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return actions.sort((a, b) => order[a.priority] - order[b.priority]);
}

/**
 * Free vs Pro presentation gates (no billing — display only).
 */
export function applyPlanGates(view, isPaid) {
  const pro = Boolean(isPaid);
  return {
    ...view,
    plan: pro ? "pro" : "free",
    gates: {
      trends: pro,
      deepCompetitors: pro,
      fullPerception: pro,
      extendedQuestions: pro,
      export: pro,
      monitoring: pro,
      allProviders: pro,
    },
    providers: pro ? view.providers : view.providers.map((p, i) => (i === 0 ? p : { ...p, locked: true })),
    competitors: {
      ...view.competitors,
      rows: pro
        ? view.competitors.rows
        : view.competitors.rows.filter((r) => r.isTarget).concat(
            view.competitors.rows.filter((r) => !r.isTarget).slice(0, 1).map((r) => ({ ...r, lockedDetail: true }))
          ),
      locked: !pro,
    },
    perception: pro
      ? view.perception
      : {
          ...view.perception,
          locked: true,
          missingThemes: (view.perception.missingThemes || []).slice(0, 1),
          unexpectedThemes: [],
          aiThemes: (view.perception.aiThemes || []).slice(0, 2),
        },
    trend: pro ? view.trend : { ...view.trend, locked: true },
    actions: pro ? view.actions : view.actions.slice(0, 2),
  };
}

/**
 * Full dashboard view-model from stored audits (no live AI calls).
 *
 * @param {object} opts
 * @param {object|null} opts.audit — detail from GET /api/audits/:id
 * @param {object[]} [opts.auditList] — from GET /api/audits
 * @param {object|null} [opts.comparison] — from compare endpoint or built locally
 * @param {boolean} [opts.isPaid]
 * @param {string} [opts.dbStatus] — "ok" | "unavailable" | "unknown"
 */
export function buildDashboardView({
  audit = null,
  auditList = [],
  comparison = null,
  isPaid = false,
  dbStatus = "ok",
} = {}) {
  if (dbStatus === "unavailable") {
    return {
      state: "db_unavailable",
      message: "Database is not configured yet. Audits cannot be loaded.",
      plan: isPaid ? "pro" : "free",
    };
  }

  if (!audit) {
    return {
      state: "empty",
      message: "No audits yet. Run a multi-AI visibility check to populate your dashboard.",
      plan: isPaid ? "pro" : "free",
      history: (auditList || []).map(mapHistoryRow),
      trend: buildTrendSeries(auditList),
    };
  }

  let cmp = comparison;
  if (!cmp && auditList?.length >= 2) {
    const sameSite = auditList.filter((a) => a.websiteId === audit.websiteId && a.id !== audit.id && a.status === "completed");
    const prev = sameSite[0]; // list is newest-first from API
    if (prev) {
      // Lightweight compare from list metrics when full previous detail isn't loaded
      cmp = compareAudits(
        {
          id: audit.id,
          websiteId: audit.websiteId,
          status: audit.status,
          completedAt: audit.completedAt,
          mentionShare: audit.mentionShare,
          recommendationShare: audit.recommendationShare,
          top3Share: audit.top3Share,
          foundScore: audit.agenticScore?.found?.score,
          foundStatus: audit.agenticScore?.found?.status,
          understoodScore: audit.agenticScore?.understood?.score,
          understoodStatus: audit.agenticScore?.understood?.status,
          recommendedScore: audit.agenticScore?.recommended?.score,
          recommendedStatus: audit.agenticScore?.recommended?.status,
          boughtScore: audit.agenticScore?.bought?.score,
          boughtStatus: audit.agenticScore?.bought?.status,
          overallScore: audit.agenticScore?.overall?.score,
          overallStatus: audit.agenticScore?.overall?.status,
          providerMetrics: audit.providerMetrics,
          competitors: audit.competitors || [],
        },
        {
          id: prev.id,
          websiteId: prev.websiteId,
          status: prev.status,
          completedAt: prev.completedAt,
          mentionShare: prev.mentionShare,
          recommendationShare: prev.recommendationShare,
          top3Share: prev.top3Share,
          foundScore: null,
          understoodScore: null,
          recommendedScore: null,
          boughtScore: null,
          overallScore: prev.overallScore,
          providerMetrics: prev.providerMetrics || {},
          competitors: prev.topCompetitors || [],
        }
      );
    }
  }

  const overall = audit.agenticScore?.overall?.score ?? audit.overallScore ?? null;
  const overallDelta = cmp?.delta?.agenticScore?.overall?.delta ?? null;

  const base = {
    state: "ready",
    header: {
      domain: audit.website?.domain || "—",
      brand: audit.website?.brandName || audit.website?.domain || "—",
      url: audit.website?.url || "",
      websiteId: audit.websiteId,
      lastAuditAt: audit.completedAt,
      status: audit.status,
      planBadge: isPaid ? "PRO" : "FREE",
    },
    hero: {
      score: overall,
      status: audit.agenticScore?.overall?.status || audit.overallStatus || (overall == null ? "not_evaluated" : "ok"),
      delta: overallDelta,
      dimensions: audit.agenticScore || null,
    },
    kpis: {
      mentionShare: {
        value: audit.mentionShare ?? null,
        delta: cmp?.delta?.share?.mentionShare?.delta ?? null,
      },
      recommendationShare: {
        value: audit.recommendationShare ?? null,
        delta: cmp?.delta?.share?.recommendationShare?.delta ?? null,
      },
      top3Share: {
        value: audit.top3Share ?? null,
        delta: cmp?.delta?.share?.top3Share?.delta ?? null,
      },
    },
    providers: buildProviderCards(audit, cmp),
    competitors: buildCompetitorView(audit, cmp),
    perception: {
      brandThemes: audit.perception?.brandThemes || audit.intelligenceSummary?.perception?.brandThemes || [],
      aiThemes: audit.perception?.aiThemes || audit.intelligenceSummary?.perception?.aiThemes || [],
      missingThemes: audit.perception?.missingThemes || audit.intelligenceSummary?.perception?.missingThemes || [],
      unexpectedThemes:
        audit.perception?.unexpectedThemes || audit.intelligenceSummary?.perception?.unexpectedThemes || [],
      method: audit.perception?.method || audit.intelligenceSummary?.perception?.method || null,
    },
    whatChanged: cmp?.missingPrevious
      ? { available: false, message: "Run another audit to see what changed." }
      : {
          available: Boolean(cmp?.delta),
          share: cmp?.delta?.share || null,
          providers: cmp?.delta?.providers || null,
          agenticScore: cmp?.delta?.agenticScore || null,
          competitors: cmp?.delta?.competitors || [],
        },
    actions: buildActionList(audit, cmp),
    history: (auditList || []).map(mapHistoryRow),
    trend: buildTrendSeries(auditList.filter((a) => !audit.websiteId || a.websiteId === audit.websiteId)),
    questions: audit.questions || [],
    partialProviderFailures: (audit.aiTests || []).some((t) => t.error),
    selectedAuditId: audit.id,
  };

  return applyPlanGates(base, isPaid);
}

function mapHistoryRow(a) {
  return {
    id: a.id,
    date: a.completedAt,
    overallScore: a.overallScore ?? null,
    mentionShare: a.mentionShare ?? null,
    recommendationShare: a.recommendationShare ?? null,
    status: a.status,
    domain: a.website?.domain || null,
  };
}
