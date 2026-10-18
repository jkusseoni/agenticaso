/**
 * Browser-side view of /api/billing/status for one signed-in Clerk user.
 * Results are keyed by user id and attempt, so a response for one account is
 * never shown to a different account after logout or account switching.
 * This module never reads Clerk metadata and never grants Pro by itself.
 */

/**
 * @param {string|null|undefined} userId
 * @param {number} attempt
 * @returns {string|null}
 */
export function billingRequestKey(userId, attempt = 0) {
  if (typeof userId !== "string" || !userId) return null;
  return `${userId}:${Number.isSafeInteger(attempt) ? attempt : 0}`;
}

/**
 * Only the server-derived fields the homepage needs.
 * @param {unknown} data
 * @returns {{ isPaid: boolean, priceLabel: string|null }}
 */
export function parseBillingStatus(data) {
  const body = /** @type {{ billing?: { isPaid?: unknown }, pricing?: { pro?: { label?: unknown } } }} */ (
    data && typeof data === "object" ? data : {}
  );
  const label = body.pricing?.pro?.label;
  const priceLabel = typeof label === "string" && label.trim() ? label.trim().slice(0, 40) : null;
  return { isPaid: body.billing?.isPaid === true, priceLabel };
}

/**
 * @param {{
 *   isLoaded?: boolean,
 *   isSignedIn?: boolean,
 *   userId?: string|null,
 *   attempt?: number,
 *   result?: { key?: string|null, error?: boolean, isPaid?: boolean, priceLabel?: string|null } | null
 * }} input
 * @returns {{ state: "loading"|"signed_out"|"error"|"free"|"pro", isPaid: boolean, priceLabel: string|null }}
 */
export function deriveBillingView({ isLoaded, isSignedIn, userId, attempt = 0, result } = {}) {
  if (!isLoaded) return { state: "loading", isPaid: false, priceLabel: null };
  const key = isSignedIn ? billingRequestKey(userId, attempt) : null;
  if (!key) return { state: "signed_out", isPaid: false, priceLabel: null };
  if (!result || result.key !== key) return { state: "loading", isPaid: false, priceLabel: null };
  if (result.error) return { state: "error", isPaid: false, priceLabel: null };
  const isPaid = result.isPaid === true;
  return { state: isPaid ? "pro" : "free", isPaid, priceLabel: result.priceLabel || null };
}

/**
 * A visibility run belongs to the user who started it.
 * @param {{ owner?: string|null, status?: string, data?: unknown, err?: string } | null | undefined} run
 * @param {string|null|undefined} userId
 */
export function ownedRunView(run, userId) {
  if (!userId || !run || run.owner !== userId) {
    return { status: "idle", data: null, err: "" };
  }
  return { status: run.status || "idle", data: run.data ?? null, err: run.err || "" };
}
