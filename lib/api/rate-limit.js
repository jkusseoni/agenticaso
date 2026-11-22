/**
 * In-process rate limiter keyed by authenticated user (and optional resource).
 * Not a substitute for ownership checks — always derive userId server-side.
 */

const HITS = new Map();
const OVERFLOW_KEY = "__rate_limit_overflow__";

/** Same-process ceiling. This is not a distributed production limiter. */
export const RATE_LIMIT_MAX_KEYS = 10_000;

function liveHits(stamps, now) {
  return (stamps || []).filter((t) => now - t < 3600_000);
}

/**
 * @param {string} key — e.g. `${userId}:export`
 * @param {number} maxPerHour
 * @param {number} maxKeys
 * @returns {boolean} true if limited
 */
export function rateLimited(key, maxPerHour = 30, maxKeys = RATE_LIMIT_MAX_KEYS) {
  const now = Date.now();
  let bucket = key;
  if (!HITS.has(key)) {
    if (HITS.size >= maxKeys) {
      for (const [existing, stamps] of HITS) {
        if (existing === OVERFLOW_KEY) continue;
        if (liveHits(stamps, now).length === 0) HITS.delete(existing);
      }
    }
    if (!HITS.has(key) && HITS.size >= maxKeys) bucket = OVERFLOW_KEY;
  }
  const arr = liveHits(HITS.get(bucket), now);
  arr.push(now);
  HITS.set(bucket, arr);
  return arr.length > maxPerHour;
}

/** Test helper */
export function _resetRateLimitsForTests() {
  HITS.clear();
}
