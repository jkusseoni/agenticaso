import { AGENTIC_SCORE_WEIGHTS } from "./config.js";

/**
 * @typedef {{ score: number|null, status: "ok"|"not_evaluated", note?: string, evidence?: object }} DimensionScore
 */

/**
 * @returns {DimensionScore}
 */
export function notEvaluated(note = "Insufficient signals to evaluate this dimension.") {
  return { score: null, status: "not_evaluated", note };
}

/**
 * @param {number} score
 * @param {string} [note]
 * @param {object} [evidence]
 * @returns {DimensionScore}
 */
export function evaluated(score, note = "", evidence = {}) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  return { score: clamped, status: "ok", note, evidence };
}

/**
 * Found — discoverability signals only when available.
 * @param {object} [ctx]
 */
export function scoreFound(ctx = {}) {
  const has =
    ctx.robotsAllowedRatio != null ||
    ctx.hasSitemap != null ||
    ctx.reachable === true;

  if (!has) return notEvaluated("No discoverability signals (robots/sitemap) provided.");

  // If we only know reachable, treat as weak partial — still evaluate conservatively
  if (ctx.robotsAllowedRatio == null && ctx.hasSitemap == null && ctx.reachable === true) {
    return evaluated(45, "Site reachable; robots/sitemap not assessed in this audit.", {
      reachable: true,
    });
  }

  let score = 30;
  if (typeof ctx.robotsAllowedRatio === "number") {
    score = 30 + Math.max(0, Math.min(1, ctx.robotsAllowedRatio)) * 50;
  }
  if (ctx.hasSitemap) score += 12;
  if (ctx.reachable) score += 8;
  return evaluated(score, "Derived from discoverability signals.", {
    robotsAllowedRatio: ctx.robotsAllowedRatio ?? null,
    hasSitemap: Boolean(ctx.hasSitemap),
    reachable: Boolean(ctx.reachable),
  });
}

/**
 * Understood — content / structured-data signals when available.
 * @param {object} [ctx]
 */
export function scoreUnderstood(ctx = {}) {
  const hasContent =
    ctx.hasTitle ||
    ctx.hasDescription ||
    ctx.hasH1 ||
    ctx.hasProductSchema ||
    ctx.hasLlms ||
    ctx.bodyTextLength > 0;

  if (!hasContent) return notEvaluated("No content/structured-data signals provided.");

  let score = 20;
  if (ctx.hasProductSchema) score += 30;
  else if (ctx.hasAnySchema) score += 14;
  if (ctx.hasLlms) score += 22;
  if (ctx.hasTitle) score += 8;
  if (ctx.hasDescription) score += 8;
  if (ctx.hasOg) score += 6;
  if (ctx.hasH1) score += 6;
  if (ctx.bodyTextLength >= 400) score += 8;
  if (ctx.jsLocked) score -= 28;

  return evaluated(score, "Derived from on-page content signals.", {
    hasTitle: Boolean(ctx.hasTitle),
    hasDescription: Boolean(ctx.hasDescription),
    hasH1: Boolean(ctx.hasH1),
    hasProductSchema: Boolean(ctx.hasProductSchema),
  });
}

/**
 * Recommended — from multi-AI recommendation intelligence.
 * @param {{ recommendationShare?: number, mentionShare?: number, top3Share?: number, totalTests?: number }} sov
 */
export function scoreRecommended(sov = {}) {
  if (!sov || !sov.totalTests) {
    return notEvaluated("No successful multi-AI provider tests to score recommendations.");
  }

  // Blend recommendation (primary), top3, and mention — configurable weights inline via formula
  const rec = sov.recommendationShare ?? 0;
  const top3 = sov.top3Share ?? 0;
  const mention = sov.mentionShare ?? 0;
  const score = rec * 0.6 + top3 * 0.25 + mention * 0.15;

  return evaluated(score, "Derived from multi-AI recommendation share of voice.", {
    recommendationShare: rec,
    top3Share: top3,
    mentionShare: mention,
    totalTests: sov.totalTests,
  });
}

/**
 * Bought — ONLY when real commerce-readiness signals exist.
 * Never fabricate from generic website signals.
 * @param {object} [ctx]
 */
export function scoreBought(ctx = {}) {
  const hasCommerce =
    ctx.isShopify === true ||
    ctx.hasProductFeed === true ||
    ctx.hasOfferSchema === true ||
    ctx.hasCheckoutSignals === true ||
    ctx.hasAcp === true ||
    ctx.hasUcp === true;

  if (!hasCommerce) {
    return notEvaluated(
      "Commerce-readiness signals (Shopify/ACP/UCP/offer feed/checkout) were not available for this audit."
    );
  }

  let score = 22;
  if (ctx.isShopify || ctx.hasAcp || ctx.hasUcp) score += 34;
  if (ctx.hasProductFeed) score += 18;
  if (ctx.hasOfferSchema) score += 16;
  if (ctx.hasCheckoutSignals) score += 10;

  return evaluated(score, "Derived from commerce-readiness signals only.", {
    isShopify: Boolean(ctx.isShopify),
    hasProductFeed: Boolean(ctx.hasProductFeed),
    hasOfferSchema: Boolean(ctx.hasOfferSchema),
    hasCheckoutSignals: Boolean(ctx.hasCheckoutSignals),
  });
}

/**
 * Aggregate agentic score from evaluated dimensions only.
 * Unevaluated dimensions are omitted from the weighted average (weights renormalized).
 *
 * @param {object} opts
 * @param {object} [opts.siteContext]
 * @param {object} [opts.shareOfVoiceOverall]
 * @param {typeof AGENTIC_SCORE_WEIGHTS} [opts.weights]
 */
export function computeAgenticScore({
  siteContext = {},
  shareOfVoiceOverall = {},
  weights = AGENTIC_SCORE_WEIGHTS,
} = {}) {
  const found = scoreFound(siteContext);
  const understood = scoreUnderstood(siteContext);
  const recommended = scoreRecommended(shareOfVoiceOverall);
  const bought = scoreBought(siteContext);

  const dims = { found, understood, recommended, bought };
  let weightSum = 0;
  let weighted = 0;

  for (const [key, dim] of Object.entries(dims)) {
    if (dim.status === "ok" && dim.score != null) {
      const w = weights[key] ?? 0;
      weightSum += w;
      weighted += dim.score * w;
    }
  }

  const overall =
    weightSum > 0
      ? {
          score: Math.round(weighted / weightSum),
          status: "ok",
          note: "Weighted average of evaluated dimensions only.",
          weightsUsed: weightSum,
        }
      : {
          score: null,
          status: "not_evaluated",
          note: "No agentic dimensions could be evaluated.",
          weightsUsed: 0,
        };

  return { found, understood, recommended, bought, overall };
}
