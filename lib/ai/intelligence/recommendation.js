import { positionScore } from "./config.js";

/**
 * Recommendation analysis for a single successful provider result.
 * Distinguishes mentioned vs recommended vs ranked.
 *
 * @param {import("../types.js").AIProviderResult} result
 * @returns {{
 *   mentionStatus: "mentioned"|"not_mentioned",
 *   recommendationStatus: "recommended"|"not_recommended",
 *   recommendationPosition: number|null,
 *   top3Presence: boolean,
 *   unrankedMention: boolean,
 *   notMentioned: boolean,
 *   positionScore: number,
 *   status: "recommended"|"ranked_top3"|"ranked"|"mentioned_unranked"|"not_mentioned"|"error"|"skipped"
 * }}
 */
export function analyzeRecommendation(result) {
  if (!result || result.error) {
    return {
      mentionStatus: "not_mentioned",
      recommendationStatus: "not_recommended",
      recommendationPosition: null,
      top3Presence: false,
      unrankedMention: false,
      notMentioned: false,
      positionScore: 0,
      status: "error",
    };
  }

  const mentioned = Boolean(result.brandMentioned);
  const recommended = Boolean(result.recommended);
  const position =
    result.brandPosition != null && Number.isFinite(result.brandPosition)
      ? Number(result.brandPosition)
      : null;

  if (!mentioned) {
    return {
      mentionStatus: "not_mentioned",
      recommendationStatus: "not_recommended",
      recommendationPosition: null,
      top3Presence: false,
      unrankedMention: false,
      notMentioned: true,
      positionScore: positionScore(null, { mentioned: false }),
      status: "not_mentioned",
    };
  }

  const top3Presence = position != null && position >= 1 && position <= 3;
  const unrankedMention = position == null;

  let status = "mentioned_unranked";
  if (recommended) status = "recommended";
  else if (top3Presence) status = "ranked_top3";
  else if (position != null) status = "ranked";

  return {
    mentionStatus: "mentioned",
    recommendationStatus: recommended ? "recommended" : "not_recommended",
    recommendationPosition: position,
    top3Presence,
    unrankedMention,
    notMentioned: false,
    positionScore: positionScore(position, { mentioned: true, recommended }),
    status,
  };
}

/**
 * Flatten byQuestion → successful provider results only.
 * Failed provider tests are excluded (do not count as "not mentioned").
 *
 * @param {Array<{ query?: string, providers?: import("../types.js").AIProviderResult[] }>} byQuestion
 * @returns {import("../types.js").AIProviderResult[]}
 */
export function successfulProviderResults(byQuestion) {
  const out = [];
  for (const row of byQuestion || []) {
    for (const p of row.providers || []) {
      if (p && !p.error) out.push(p);
    }
  }
  return out;
}

/**
 * All provider results including failures (for diagnostics).
 * @param {Array<{ providers?: import("../types.js").AIProviderResult[] }>} byQuestion
 */
export function allProviderResults(byQuestion) {
  const out = [];
  for (const row of byQuestion || []) {
    for (const p of row.providers || []) {
      if (p) out.push(p);
    }
  }
  return out;
}
