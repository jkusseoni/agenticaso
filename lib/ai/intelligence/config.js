/**
 * Configurable scoring maps for Phase 2 intelligence.
 * Keep magic numbers here — do not scatter them.
 */

/** Position → score mapping for recommendation analysis (not final business metric). */
export const POSITION_SCORE_MAP = Object.freeze({
  1: 100,
  2: 80,
  3: 60,
  4: 40,
  5: 30,
  unrankedMention: 20,
  notMentioned: 0,
});

/**
 * @param {number|null|undefined} position
 * @param {{ mentioned?: boolean, recommended?: boolean }} [flags]
 * @returns {number}
 */
export function positionScore(position, flags = {}) {
  const mentioned = Boolean(flags.mentioned);
  if (!mentioned) return POSITION_SCORE_MAP.notMentioned;
  if (position == null || !Number.isFinite(position)) return POSITION_SCORE_MAP.unrankedMention;
  const key = Math.trunc(position);
  if (Object.prototype.hasOwnProperty.call(POSITION_SCORE_MAP, key)) {
    return POSITION_SCORE_MAP[key];
  }
  // Ranked beyond #5 but still mentioned
  if (key > 5) return POSITION_SCORE_MAP.unrankedMention;
  return POSITION_SCORE_MAP.notMentioned;
}

/** Weights for aggregating evaluated agentic dimensions (sum should be 1 when all present). */
export const AGENTIC_SCORE_WEIGHTS = Object.freeze({
  found: 0.2,
  understood: 0.2,
  recommended: 0.45,
  bought: 0.15,
});

export const PROVIDER_IDS = Object.freeze(["openai", "perplexity", "gemini"]);
