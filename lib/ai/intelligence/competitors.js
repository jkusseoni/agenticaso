import { normBrand } from "../brand.js";
import { successfulProviderResults } from "./recommendation.js";
import { percent } from "./share-of-voice.js";

/**
 * Aggregate competitor intelligence from successful provider results only.
 * Uses existing competitor extraction on each result — does not invent names
 * and does not treat citation URLs as competitors.
 *
 * @param {Array<{ providers?: import("../types.js").AIProviderResult[] }>} byQuestion
 * @param {string} targetBrand
 */
export function computeCompetitorIntelligence(byQuestion, targetBrand) {
  const target = normBrand(targetBrand);
  /** @type {Map<string, { name: string, mentions: number, recommendations: number, top3: number, positionSum: number, positionN: number }>} */
  const map = new Map();

  const results = successfulProviderResults(byQuestion);
  for (const r of results) {
    for (const c of r.competitors || []) {
      const name = String(c?.name || "").trim();
      if (!name) continue;
      const key = normBrand(name);
      if (!key || key === target) continue;

      if (!map.has(key)) {
        map.set(key, {
          name,
          mentions: 0,
          recommendations: 0,
          top3: 0,
          positionSum: 0,
          positionN: 0,
        });
      }
      const row = map.get(key);
      row.mentions += 1;

      const pos = c.position != null && Number.isFinite(c.position) ? Number(c.position) : null;
      if (pos != null) {
        row.positionSum += pos;
        row.positionN += 1;
        if (pos >= 1 && pos <= 3) row.top3 += 1;
        // Treat position 1 as a recommendation signal when structured data says so
        if (pos === 1) row.recommendations += 1;
      }
    }

    // If structured competitor marked recommended via position 1 already counted;
    // also bump recommendation when answer explicitly recommends that competitor at #1
    // (already handled via position === 1 above).
  }

  const totalTests = results.length || 0;

  return [...map.values()]
    .map((row) => ({
      name: row.name,
      mentions: row.mentions,
      recommendations: row.recommendations,
      top3: row.top3,
      averagePosition:
        row.positionN > 0 ? Math.round((row.positionSum / row.positionN) * 10) / 10 : null,
      mentionShare: percent(row.mentions, totalTests),
      recommendationShare: percent(row.recommendations, totalTests),
      top3Share: percent(row.top3, totalTests),
    }))
    .sort((a, b) => b.mentions - a.mentions || b.recommendations - a.recommendations)
    .slice(0, 15);
}

/**
 * Target vs top competitor recommendation gap (percentage points).
 *
 * @param {{ recommendationShare: number }} targetSov
 * @param {ReturnType<typeof computeCompetitorIntelligence>} competitors
 */
export function computeCompetitorGap(targetSov, competitors) {
  const ranked = [...(competitors || [])].sort(
    (a, b) => b.recommendationShare - a.recommendationShare || b.mentionShare - a.mentionShare
  );

  if (!ranked.length) {
    return {
      targetShare: targetSov?.recommendationShare ?? 0,
      competitorShare: null,
      gap: null,
      competitorName: null,
      ranked: [],
    };
  }

  const top = ranked[0];
  const targetShare = targetSov?.recommendationShare ?? 0;
  const competitorShare = top.recommendationShare;
  const gap = targetShare - competitorShare;

  return {
    targetShare,
    competitorShare,
    gap,
    competitorName: top.name,
    ranked: ranked.slice(0, 5).map((c) => ({
      competitorName: c.name,
      targetShare,
      competitorShare: c.recommendationShare,
      gap: targetShare - c.recommendationShare,
    })),
  };
}
