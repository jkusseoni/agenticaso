import { PROVIDER_IDS } from "./config.js";
import { analyzeRecommendation, successfulProviderResults } from "./recommendation.js";

/**
 * Safe percentage helper — avoids divide-by-zero.
 * @param {number} count
 * @param {number} total
 * @returns {number} 0–100, rounded
 */
export function percent(count, total) {
  if (!total || total <= 0) return 0;
  return Math.round((count / total) * 100);
}

/**
 * Share-of-voice metrics from successful provider tests only.
 *
 * @param {import("../types.js").AIProviderResult[]} results
 */
export function computeShareOfVoice(results) {
  const tests = results || [];
  const totalTests = tests.length;

  let mentionCount = 0;
  let recommendationCount = 0;
  let top3Count = 0;

  for (const r of tests) {
    const a = analyzeRecommendation(r);
    if (a.mentionStatus === "mentioned") mentionCount++;
    if (a.recommendationStatus === "recommended") recommendationCount++;
    if (a.top3Presence) top3Count++;
  }

  return {
    mentionCount,
    recommendationCount,
    top3Count,
    totalTests,
    mentionShare: percent(mentionCount, totalTests),
    recommendationShare: percent(recommendationCount, totalTests),
    top3Share: percent(top3Count, totalTests),
  };
}

/**
 * Provider-level SoV. Failed tests for a provider are excluded from that provider's denominator.
 *
 * @param {Array<{ providers?: import("../types.js").AIProviderResult[] }>} byQuestion
 */
export function computeProviderShareOfVoice(byQuestion) {
  /** @type {Record<string, import("../types.js").AIProviderResult[]>} */
  const buckets = Object.fromEntries(PROVIDER_IDS.map((id) => [id, []]));

  for (const row of byQuestion || []) {
    for (const p of row.providers || []) {
      if (!p || p.error) continue;
      const id = p.provider;
      if (!buckets[id]) buckets[id] = [];
      buckets[id].push(p);
    }
  }

  /** @type {Record<string, object>} */
  const out = {};
  for (const id of Object.keys(buckets)) {
    const sov = computeShareOfVoice(buckets[id]);
    out[id] = {
      mentionShare: sov.mentionShare,
      recommendationShare: sov.recommendationShare,
      top3Share: sov.top3Share,
      mentionCount: sov.mentionCount,
      recommendationCount: sov.recommendationCount,
      top3Count: sov.top3Count,
      tests: sov.totalTests,
    };
  }

  // Ensure openai/perplexity/gemini keys always present
  for (const id of PROVIDER_IDS) {
    if (!out[id]) {
      out[id] = {
        mentionShare: 0,
        recommendationShare: 0,
        top3Share: 0,
        mentionCount: 0,
        recommendationCount: 0,
        top3Count: 0,
        tests: 0,
      };
    }
  }

  return out;
}

/**
 * Overall + per-provider SoV from a v2 byQuestion payload.
 * @param {Array<{ providers?: import("../types.js").AIProviderResult[] }>} byQuestion
 */
export function buildShareOfVoice(byQuestion) {
  const successful = successfulProviderResults(byQuestion);
  return {
    overall: computeShareOfVoice(successful),
    providers: computeProviderShareOfVoice(byQuestion),
  };
}
