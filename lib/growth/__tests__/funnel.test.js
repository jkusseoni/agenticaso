/**
 * Growth funnel persistence (mocked; no database).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FUNNEL_EVENTS,
  getGrowthFunnelSummary,
  isAllowedFunnelEvent,
  recordFunnelEvent,
} from "../funnel.js";

function inRange(value, filter) {
  if (!filter) return true;
  if (value == null) return false;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return false;
  if (filter.gte && time < new Date(filter.gte).getTime()) return false;
  if (filter.lte && time > new Date(filter.lte).getTime()) return false;
  if (filter.not === null && value == null) return false;
  return true;
}

function matches(row, where) {
  if (!where) return true;
  if (where.event) {
    if (typeof where.event === "string" && row.event !== where.event) return false;
    if (where.event.in && !where.event.in.includes(row.event)) return false;
  }
  if (where.createdAt && !inRange(row.createdAt, where.createdAt)) return false;
  if (where.firstPaidAt) {
    if (where.firstPaidAt.not === null && row.firstPaidAt == null) return false;
    if ((where.firstPaidAt.gte || where.firstPaidAt.lte) && !inRange(row.firstPaidAt, where.firstPaidAt)) {
      return false;
    }
  }
  if (where.NOT?.workspaceId === null && row.workspaceId == null) return false;
  if (where.NOT?.firstPaidAt === null && row.firstPaidAt == null) return false;
  return true;
}

function fakeDb({ failCreates = 0 } = {}) {
  const events = [];
  const subscriptions = [];
  let remainingFails = failCreates;
  return {
    funnelEvent: {
      create: async ({ data }) => {
        if (remainingFails > 0) {
          remainingFails -= 1;
          const err = new Error("db_down");
          err.code = "P1001";
          throw err;
        }
        const row = {
          id: `fe_${events.length + 1}`,
          createdAt: data.createdAt ? new Date(data.createdAt) : new Date(),
          sessionId: data.sessionId ?? null,
          workspaceId: data.workspaceId ?? null,
          event: data.event,
        };
        events.push(row);
        return row;
      },
      findMany: async ({ where }) => events.filter((row) => matches(row, where)),
    },
    subscription: {
      findMany: async ({ where }) => subscriptions.filter((row) => matches(row, where)),
    },
    seedEvent(data) {
      events.push({
        id: `fe_${events.length + 1}`,
        sessionId: null,
        workspaceId: null,
        ...data,
        createdAt: new Date(data.createdAt),
      });
    },
    seedPaid(data) {
      subscriptions.push({ workspaceId: "ws_x", firstPaidAmount: null, firstPaidCurrency: null, ...data });
    },
    _events: events,
  };
}

describe("recordFunnelEvent", () => {
  it("records an allowed ChatGPT click", async () => {
    const db = fakeDb();
    const result = await recordFunnelEvent({
      event: FUNNEL_EVENTS.CHATGPT_PLUGIN_CTA_CLICK,
      sessionId: "sess_1",
      db,
    });
    assert.equal(result.recorded, true);
    assert.equal(result.ok, true);
    assert.equal(db._events.length, 1);
    assert.equal(db._events[0].event, "chatgpt_plugin_cta_click");
    assert.equal(db._events[0].sessionId, "sess_1");
    assert.equal(db._events[0].workspaceId, null);
  });

  it("records an allowed checkout event with a workspace", async () => {
    const db = fakeDb();
    const result = await recordFunnelEvent({
      event: "pro_checkout_started",
      sessionId: "sess_2",
      workspaceId: "ws_1",
      db,
    });
    assert.equal(result.recorded, true);
    assert.equal(db._events[0].event, "pro_checkout_started");
    assert.equal(db._events[0].workspaceId, "ws_1");
  });

  it("does not record an unknown event and does not throw", async () => {
    const db = fakeDb();
    const result = await recordFunnelEvent({ event: "page_view", sessionId: "sess_1", db });
    assert.equal(result.recorded, false);
    assert.equal(result.reason, "rejected");
    assert.equal(isAllowedFunnelEvent("page_view"), false);
    assert.equal(db._events.length, 0);
  });

  it("stores null sessionId and null workspaceId", async () => {
    const db = fakeDb();
    await recordFunnelEvent({
      event: FUNNEL_EVENTS.CHATGPT_PLUGIN_CTA_CLICK,
      sessionId: "   ",
      workspaceId: null,
      db,
    });
    assert.equal(db._events[0].sessionId, null);
    assert.equal(db._events[0].workspaceId, null);
  });

  it("returns persist_failed instead of throwing when storage fails", async () => {
    const db = fakeDb({ failCreates: 1 });
    let continued = false;
    const result = await recordFunnelEvent({
      event: FUNNEL_EVENTS.PRO_CHECKOUT_STARTED,
      workspaceId: "ws_1",
      db,
    });
    continued = true;
    assert.equal(continued, true);
    assert.equal(result.ok, false);
    assert.equal(result.recorded, false);
    assert.equal(result.reason, "persist_failed");
    assert.equal(db._events.length, 0);
  });
});

describe("getGrowthFunnelSummary", () => {
  it("filters event counts by date range and counts distinct checkout workspaces", async () => {
    const db = fakeDb();
    db.seedEvent({ event: "chatgpt_plugin_cta_click", createdAt: "2027-06-01T00:00:00.000Z", sessionId: "a" });
    db.seedEvent({ event: "chatgpt_plugin_cta_click", createdAt: "2027-06-02T00:00:00.000Z", sessionId: "b" });
    db.seedEvent({ event: "chatgpt_plugin_cta_click", createdAt: "2027-07-01T00:00:00.000Z", sessionId: "c" });
    db.seedEvent({
      event: "pro_checkout_started",
      createdAt: "2027-06-03T00:00:00.000Z",
      workspaceId: "ws_1",
    });
    db.seedEvent({
      event: "pro_checkout_started",
      createdAt: "2027-06-04T00:00:00.000Z",
      workspaceId: "ws_1",
    });
    db.seedEvent({
      event: "pro_checkout_started",
      createdAt: "2027-06-05T00:00:00.000Z",
      workspaceId: "ws_2",
    });
    db.seedEvent({
      event: "pro_checkout_started",
      createdAt: "2027-06-06T00:00:00.000Z",
      workspaceId: null,
    });
    db.seedEvent({
      event: "pro_checkout_started",
      createdAt: "2027-08-01T00:00:00.000Z",
      workspaceId: "ws_3",
    });

    const summary = await getGrowthFunnelSummary(db, {
      from: "2027-06-01T00:00:00.000Z",
      to: "2027-06-30T00:00:00.000Z",
    });
    assert.equal(summary.chatgptPluginCtaClicks, 2);
    assert.equal(summary.proCheckoutStarts, 4);
    assert.equal(summary.distinctCheckoutWorkspaces, 2);
  });

  it("counts first-paid customers and groups revenue by currency, skipping null amounts", async () => {
    const db = fakeDb();
    db.seedPaid({
      workspaceId: "ws_usd",
      firstPaidAt: "2027-06-10T00:00:00.000Z",
      firstPaidAmount: 1900,
      firstPaidCurrency: "USD",
    });
    db.seedPaid({
      workspaceId: "ws_eur",
      firstPaidAt: "2027-06-11T00:00:00.000Z",
      firstPaidAmount: 2000,
      firstPaidCurrency: "EUR",
    });
    db.seedPaid({
      workspaceId: "ws_backfill",
      firstPaidAt: "2027-06-12T00:00:00.000Z",
      firstPaidAmount: null,
      firstPaidCurrency: null,
    });
    db.seedPaid({
      workspaceId: "ws_old",
      firstPaidAt: "2027-05-01T00:00:00.000Z",
      firstPaidAmount: 1900,
      firstPaidCurrency: "USD",
    });

    const summary = await getGrowthFunnelSummary(db, {
      from: "2027-06-01T00:00:00.000Z",
      to: "2027-06-30T00:00:00.000Z",
    });
    assert.equal(summary.firstPaidCustomers, 3);
    assert.deepEqual(summary.revenueByCurrency, [
      { currency: "EUR", amountMinor: 2000 },
      { currency: "USD", amountMinor: 1900 },
    ]);
  });

  it("attributes checkout-to-paid only for the same workspace when payment is not before checkout", async () => {
    const db = fakeDb();
    db.seedEvent({
      event: "pro_checkout_started",
      createdAt: "2027-06-02T00:00:00.000Z",
      workspaceId: "ws_match",
    });
    db.seedEvent({
      event: "pro_checkout_started",
      createdAt: "2027-06-05T00:00:00.000Z",
      workspaceId: "ws_early_pay",
    });
    db.seedEvent({
      event: "pro_checkout_started",
      createdAt: "2027-06-01T00:00:00.000Z",
      workspaceId: "ws_other",
    });
    db.seedPaid({
      workspaceId: "ws_match",
      firstPaidAt: "2027-06-02T00:00:00.000Z",
      firstPaidAmount: 1900,
      firstPaidCurrency: "USD",
    });
    db.seedPaid({
      workspaceId: "ws_early_pay",
      firstPaidAt: "2027-06-01T00:00:00.000Z",
      firstPaidAmount: 1900,
      firstPaidCurrency: "USD",
    });
    db.seedPaid({
      workspaceId: "ws_historical",
      firstPaidAt: "2027-06-03T00:00:00.000Z",
      firstPaidAmount: 1900,
      firstPaidCurrency: "USD",
    });

    const summary = await getGrowthFunnelSummary(db, {
      from: "2027-06-01T00:00:00.000Z",
      to: "2027-06-30T00:00:00.000Z",
    });
    assert.equal(summary.firstPaidCustomers, 3);
    assert.equal(summary.checkoutToPaid, 1);
  });
});
