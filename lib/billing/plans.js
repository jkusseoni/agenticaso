/**
 * Central plan + entitlement configuration.
 * Limits are configurable here — do not scatter plan checks elsewhere.
 */

export const PLAN_IDS = Object.freeze({
  FREE: "free",
  PRO: "pro",
  AGENCY: "agency",
});

/** Unlimited sentinel (null). Prefer helpers that treat null as unlimited. */
export const UNLIMITED = null;

/**
 * @typedef {object} PlanEntitlements
 * @property {string} id
 * @property {string} name
 * @property {boolean} purchasable
 * @property {number|null} websites
 * @property {number|null} buyerQuestions
 * @property {number|null} historicalAudits
 * @property {number|null} monitoring
 * @property {number|null} teamMembers
 * @property {number|null} aiTestsPerMonth
 * @property {number|null} exports
 * @property {boolean} advancedCompetitors
 * @property {boolean} advancedDiagnosis
 */

/** @type {Record<string, PlanEntitlements>} */
export const PLANS = Object.freeze({
  [PLAN_IDS.FREE]: Object.freeze({
    id: PLAN_IDS.FREE,
    name: "Free",
    purchasable: false,
    websites: 1,
    buyerQuestions: 5,
    historicalAudits: 3,
    monitoring: 0,
    teamMembers: 1,
    aiTestsPerMonth: 45,
    exports: 0,
    advancedCompetitors: false,
    advancedDiagnosis: false,
  }),
  [PLAN_IDS.PRO]: Object.freeze({
    id: PLAN_IDS.PRO,
    name: "Pro",
    purchasable: true,
    websites: 3,
    buyerQuestions: 50,
    historicalAudits: UNLIMITED,
    monitoring: 3,
    teamMembers: 1,
    aiTestsPerMonth: 3000,
    exports: UNLIMITED,
    advancedCompetitors: true,
    advancedDiagnosis: true,
  }),
  [PLAN_IDS.AGENCY]: Object.freeze({
    id: PLAN_IDS.AGENCY,
    name: "Agency",
    purchasable: false,
    websites: 25,
    buyerQuestions: 200,
    historicalAudits: UNLIMITED,
    monitoring: 25,
    teamMembers: 5,
    aiTestsPerMonth: 20000,
    exports: UNLIMITED,
    advancedCompetitors: true,
    advancedDiagnosis: true,
  }),
});

/** Canonical Pro price: $19/month. UI must import these — do not hard-code prices. */
export const DEFAULT_PRO_CURRENCY = "USD";
export const DEFAULT_PRO_CURRENCY_SYMBOL = "$";
export const DEFAULT_PRO_MONTHLY_DISPLAY = "19";
export const DEFAULT_PRO_MONTHLY_CENTS = 1900;
export const DEFAULT_PRO_PRICE_LABEL = `${DEFAULT_PRO_CURRENCY_SYMBOL}${DEFAULT_PRO_MONTHLY_DISPLAY}/month`;

/** @deprecated Use DEFAULT_PRO_MONTHLY_CENTS. Kept so old env names do not crash. */
export const DEFAULT_PRO_MONTHLY_PAISE = DEFAULT_PRO_MONTHLY_CENTS;

export const PRICING = Object.freeze({
  currency: process.env.BILLING_PRO_CURRENCY || DEFAULT_PRO_CURRENCY,
  currencySymbol: process.env.BILLING_PRO_CURRENCY_SYMBOL || DEFAULT_PRO_CURRENCY_SYMBOL,
  proMonthlyCents: Number(process.env.BILLING_PRO_MONTHLY_CENTS || DEFAULT_PRO_MONTHLY_CENTS),
  proMonthlyDisplay: process.env.BILLING_PRO_MONTHLY_DISPLAY || DEFAULT_PRO_MONTHLY_DISPLAY,
  /** Alias of proMonthlyCents (legacy name). */
  proMonthlyPaise: Number(
    process.env.BILLING_PRO_MONTHLY_CENTS ||
      process.env.BILLING_PRO_MONTHLY_PAISE ||
      DEFAULT_PRO_MONTHLY_CENTS
  ),
});

export function getPlan(planId) {
  const id = String(planId || PLAN_IDS.FREE).toLowerCase();
  return PLANS[id] || PLANS[PLAN_IDS.FREE];
}

export function isUnlimited(value) {
  return value === UNLIMITED || value === -1;
}

export function formatMoney(cents = PRICING.proMonthlyCents, currency = PRICING.currency) {
  const amount = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${PRICING.currencySymbol}${PRICING.proMonthlyDisplay}`;
  }
}

export function formatPlanPriceLabel() {
  return `${formatMoney(PRICING.proMonthlyCents)}/month`;
}
