/**
 * In-process rate limiter keyed by authenticated user (and optional resource).
 * Not a substitute for ownership checks — always derive userId server-side.
 */

const HITS = new Map();

/**
 * @param {string} key — e.g. `${userId}:export`
 * @param {number} maxPerHour
 * @returns {boolean} true if limited
 */
export function rateLimited(key, maxPerHour = 30) {
  const now = Date.now();
  const arr = (HITS.get(key) || []).filter((t) => now - t < 3600_000);
  arr.push(now);
  HITS.set(key, arr);
  return arr.length > maxPerHour;
}

/** Test helper */
export function _resetRateLimitsForTests() {
  HITS.clear();
}
