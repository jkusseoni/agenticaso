/**
 * Aggregate labels for the internal growth page.
 * These helpers accept counts and currency totals only.
 */

export const GROWTH_RANGE_DAYS = Object.freeze([7, 30, 90]);
export const DEFAULT_GROWTH_RANGE_DAYS = 30;

export const GROWTH_TRACKING_NOTE =
  "Click and checkout metrics are recorded only from the launch of first-party funnel tracking; historical Vercel Analytics events were not backfilled.";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {string|string[]|null|undefined} value
 * @returns {7|30|90}
 */
export function parseGrowthRangeDays(value) {
  if (Array.isArray(value)) return DEFAULT_GROWTH_RANGE_DAYS;
  if (value == null) return DEFAULT_GROWTH_RANGE_DAYS;
  const text = String(value).trim();
  if (text === "7" || text === "30" || text === "90") return Number(text);
  return DEFAULT_GROWTH_RANGE_DAYS;
}

/**
 * @param {{ days?: string|string[]|null }|null|undefined} searchParams
 * @param {Date} [now]
 */
export function growthWindowFromSearchParams(searchParams, now = new Date()) {
  const days = parseGrowthRangeDays(searchParams?.days);
  const to = new Date(now);
  const from = new Date(to.getTime() - days * DAY_MS);
  return { days, from, to };
}

/**
 * Attributed paid workspaces / distinct checkout workspaces.
 * A zero denominator is an em dash, not a number.
 * @param {number} attributed
 * @param {number} distinctCheckoutWorkspaces
 */
export function formatCheckoutToPaidRate(attributed, distinctCheckoutWorkspaces) {
  const starts = Number(distinctCheckoutWorkspaces);
  const paid = Number(attributed);
  if (!Number.isFinite(starts) || starts <= 0 || !Number.isFinite(paid)) return "—";
  const rate = (paid / starts) * 100;
  if (!Number.isFinite(rate)) return "—";
  const rounded = Math.round(rate * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function currencyMinorDigits(currency) {
  const digits = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).resolvedOptions().maximumFractionDigits;
  return Number.isInteger(digits) && digits >= 0 ? digits : null;
}

/**
 * Format a minor-unit total with the currency's own fraction digits.
 * @param {number} amountMinor
 * @param {string} currency
 * @returns {string|null}
 */
export function formatMinorRevenue(amountMinor, currency) {
  if (amountMinor == null || amountMinor === "") return null;
  const amount = Number(amountMinor);
  const code = String(currency || "").trim().toUpperCase();
  if (!Number.isFinite(amount) || !/^[A-Z]{3}$/.test(code)) return null;
  try {
    const digits = currencyMinorDigits(code);
    if (digits == null) return null;
    const major = amount / 10 ** digits;
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
    }).format(major);
  } catch {
    return null;
  }
}

/**
 * @param {{ currency?: string|null, amountMinor?: number|null }[]|null|undefined} rows
 * @returns {string[]}
 */
export function formatRevenueLines(rows) {
  if (!Array.isArray(rows)) return [];
  const lines = [];
  for (const row of rows) {
    if (row?.amountMinor == null || !row.currency) continue;
    const line = formatMinorRevenue(row.amountMinor, row.currency);
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * @param {{
 *   chatgptPluginCtaClicks?: number,
 *   proCheckoutStarts?: number,
 *   distinctCheckoutWorkspaces?: number,
 *   firstPaidCustomers?: number,
 *   checkoutToPaid?: number,
 *   revenueByCurrency?: { currency: string, amountMinor: number }[]
 * }} summary
 * @param {number} days
 */
export function buildGrowthDashboardView(summary, days) {
  const revenueLines = formatRevenueLines(summary?.revenueByCurrency);
  return {
    days,
    chatgptPluginCtaClicks: summary?.chatgptPluginCtaClicks ?? 0,
    proCheckoutStarts: summary?.proCheckoutStarts ?? 0,
    distinctCheckoutWorkspaces: summary?.distinctCheckoutWorkspaces ?? 0,
    firstPaidCustomers: summary?.firstPaidCustomers ?? 0,
    checkoutToPaid: summary?.checkoutToPaid ?? 0,
    checkoutToPaidRateLabel: formatCheckoutToPaidRate(
      summary?.checkoutToPaid,
      summary?.distinctCheckoutWorkspaces
    ),
    revenueLines,
    revenueLabel: revenueLines.length ? revenueLines.join(", ") : "—",
    trackingNote: GROWTH_TRACKING_NOTE,
  };
}
