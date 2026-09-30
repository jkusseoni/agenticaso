/**
 * Durable conversion-funnel counts.
 * Persistence failures are returned, not thrown, so a checkout or click can continue.
 * This module does not grant Pro and does not write Subscription.
 */
import { getPrisma } from "../db/prisma.js";

export const FUNNEL_EVENTS = Object.freeze({
  CHATGPT_PLUGIN_CTA_CLICK: "chatgpt_plugin_cta_click",
  PRO_CHECKOUT_STARTED: "pro_checkout_started",
});

const ALLOWED_FUNNEL_EVENTS = new Set(Object.values(FUNNEL_EVENTS));

export function isAllowedFunnelEvent(event) {
  return ALLOWED_FUNNEL_EVENTS.has(event);
}

function cleanOptionalId(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function asDate(value) {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Inclusive createdAt / firstPaidAt bounds. Omitted ends are open.
 * @param {Date|string|null|undefined} from
 * @param {Date|string|null|undefined} to
 */
function rangeFilter(from, to) {
  const start = asDate(from);
  const end = asDate(to);
  if (!start && !end) return undefined;
  /** @type {{ gte?: Date, lte?: Date }} */
  const filter = {};
  if (start) filter.gte = start;
  if (end) filter.lte = end;
  return filter;
}

/**
 * Record one allowlisted funnel event.
 * Unknown names are not stored. Database errors are caught.
 * @param {{ event?: string, sessionId?: string|null, workspaceId?: string|null, db?: import("@prisma/client").PrismaClient|null }} input
 * @returns {Promise<{ ok: boolean, recorded: boolean, reason: string|null, id: string|null }>}
 */
export async function recordFunnelEvent({ event, sessionId = null, workspaceId = null, db } = {}) {
  if (!isAllowedFunnelEvent(event)) {
    return { ok: false, recorded: false, reason: "rejected", id: null };
  }

  const client = db === undefined ? getPrisma() : db;
  if (!client?.funnelEvent?.create) {
    return { ok: false, recorded: false, reason: "unavailable", id: null };
  }

  try {
    const row = await client.funnelEvent.create({
      data: {
        event,
        sessionId: cleanOptionalId(sessionId),
        workspaceId: cleanOptionalId(workspaceId),
      },
    });
    return { ok: true, recorded: true, reason: null, id: row?.id ?? null };
  } catch (e) {
    console.error("funnel event persist failed:", e?.code || "error");
    return { ok: false, recorded: false, reason: "persist_failed", id: null };
  }
}

/**
 * Aggregates for a later internal growth page.
 * Checkout-to-paid counts a workspace only when its earliest
 * pro_checkout_started is at or before Subscription.firstPaidAt.
 * Paid rows with no checkout event are not attributed.
 * Null firstPaidAmount is excluded from revenue and still counts as a customer.
 * @param {import("@prisma/client").PrismaClient} db
 * @param {{ from?: Date|string|null, to?: Date|string|null }} [range]
 */
export async function getGrowthFunnelSummary(db, { from = null, to = null } = {}) {
  const eventRange = rangeFilter(from, to);
  const paidRange = rangeFilter(from, to);

  const events = await db.funnelEvent.findMany({
    where: {
      ...(eventRange ? { createdAt: eventRange } : {}),
      event: { in: [...ALLOWED_FUNNEL_EVENTS] },
    },
    select: { event: true, workspaceId: true, createdAt: true },
  });

  const checkouts = await db.funnelEvent.findMany({
    where: {
      event: FUNNEL_EVENTS.PRO_CHECKOUT_STARTED,
      NOT: { workspaceId: null },
    },
    select: { workspaceId: true, createdAt: true },
  });

  const paid = await db.subscription.findMany({
    where: {
      NOT: { firstPaidAt: null },
      ...(paidRange ? { firstPaidAt: paidRange } : {}),
    },
    select: {
      workspaceId: true,
      firstPaidAt: true,
      firstPaidAmount: true,
      firstPaidCurrency: true,
    },
  });

  let chatgptPluginCtaClicks = 0;
  let proCheckoutStarts = 0;
  const checkoutWorkspaces = new Set();
  for (const row of events) {
    if (row.event === FUNNEL_EVENTS.CHATGPT_PLUGIN_CTA_CLICK) chatgptPluginCtaClicks += 1;
    if (row.event === FUNNEL_EVENTS.PRO_CHECKOUT_STARTED) {
      proCheckoutStarts += 1;
      if (row.workspaceId) checkoutWorkspaces.add(row.workspaceId);
    }
  }

  const firstCheckoutAt = new Map();
  for (const row of checkouts) {
    if (!row.workspaceId) continue;
    const at = new Date(row.createdAt).getTime();
    if (!Number.isFinite(at)) continue;
    const prev = firstCheckoutAt.get(row.workspaceId);
    if (prev == null || at < prev) firstCheckoutAt.set(row.workspaceId, at);
  }

  /** @type {Map<string, number>} */
  const revenue = new Map();
  let checkoutToPaid = 0;
  for (const row of paid) {
    if (row.firstPaidAmount != null && row.firstPaidCurrency) {
      const currency = String(row.firstPaidCurrency);
      revenue.set(currency, (revenue.get(currency) || 0) + Number(row.firstPaidAmount));
    }
    const started = firstCheckoutAt.get(row.workspaceId);
    const paidAt = new Date(row.firstPaidAt).getTime();
    if (started != null && Number.isFinite(paidAt) && paidAt >= started) checkoutToPaid += 1;
  }

  return {
    from: asDate(from),
    to: asDate(to),
    chatgptPluginCtaClicks,
    proCheckoutStarts,
    distinctCheckoutWorkspaces: checkoutWorkspaces.size,
    firstPaidCustomers: paid.length,
    revenueByCurrency: [...revenue.entries()]
      .map(([currency, amountMinor]) => ({ currency, amountMinor }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    checkoutToPaid,
  };
}
