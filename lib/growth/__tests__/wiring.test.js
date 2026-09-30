/**
 * Growth funnel wiring. No database and no Next.js request context.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { recordTrustedCheckoutStart } from "../checkout-start.js";
import { handleChatgptFunnelPost, lookupSignedInWorkspaceId } from "../click.js";
import { getGrowthFunnelSummary } from "../funnel.js";
import { notifyChatgptPluginClick } from "../homepage-click.js";
import {
  FUNNEL_SESSION_COOKIE,
  FUNNEL_SESSION_MAX_AGE_SECONDS,
  createFunnelSessionId,
  ensureFunnelSession,
  funnelSessionCookieOptions,
  isFunnelSessionId,
  readFunnelSession,
} from "../session.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function memoryCookies(initial = {}) {
  const jar = new Map(Object.entries(initial));
  const sets = [];
  return {
    sets,
    get(name) {
      const value = jar.get(name);
      return value == null ? undefined : { name, value };
    },
    set(name, value, options) {
      jar.set(name, value);
      sets.push({ name, value, options });
    },
  };
}

function fakeDb() {
  const events = [];
  const subscriptions = [];
  return {
    funnelEvent: {
      create: async ({ data }) => {
        const row = {
          id: `fe_${events.length + 1}`,
          event: data.event,
          sessionId: data.sessionId ?? null,
          workspaceId: data.workspaceId ?? null,
          createdAt: new Date(),
        };
        events.push(row);
        return row;
      },
      findMany: async ({ where }) => events.filter((row) => matches(row, where)),
    },
    subscription: {
      findMany: async ({ where }) => subscriptions.filter((row) => matches(row, where)),
    },
    seedPaid(data) {
      subscriptions.push({
        workspaceId: "ws_x",
        firstPaidAmount: null,
        firstPaidCurrency: null,
        ...data,
        firstPaidAt: new Date(data.firstPaidAt),
      });
    },
    _events: events,
  };
}

function matches(row, where) {
  if (!where) return true;
  if (where.event) {
    if (typeof where.event === "string" && row.event !== where.event) return false;
    if (where.event.in && !where.event.in.includes(row.event)) return false;
  }
  if (where.NOT?.workspaceId === null && row.workspaceId == null) return false;
  if (where.NOT?.firstPaidAt === null && row.firstPaidAt == null) return false;
  return true;
}

describe("funnel session cookie", () => {
  it("uses an opaque httpOnly cookie and never stores a workspace id", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const options = funnelSessionCookieOptions();
      assert.equal(options.httpOnly, true);
      assert.equal(options.secure, true);
      assert.equal(options.sameSite, "lax");
      assert.equal(options.path, "/");
      assert.equal(options.maxAge, FUNNEL_SESSION_MAX_AGE_SECONDS);
      assert.equal(options.maxAge, 60 * 60 * 24 * 30);
    } finally {
      process.env.NODE_ENV = previous;
    }

    process.env.NODE_ENV = "development";
    try {
      assert.equal(funnelSessionCookieOptions().secure, false);
    } finally {
      process.env.NODE_ENV = previous;
    }

    const jar = memoryCookies({ [FUNNEL_SESSION_COOKIE]: "ws_client_supplied" });
    const sessionId = ensureFunnelSession(jar);
    assert.equal(isFunnelSessionId(sessionId), true);
    assert.equal(sessionId.includes("ws_"), false);
    assert.equal(jar.sets[0].name, FUNNEL_SESSION_COOKIE);
    assert.equal(jar.sets[0].value, sessionId);
    assert.equal(jar.sets[0].options.httpOnly, true);
    assert.equal(JSON.stringify(jar.sets[0]).includes("workspace"), false);

    const again = ensureFunnelSession(jar);
    assert.equal(again, sessionId);
    assert.equal(readFunnelSession(jar), sessionId);
    assert.equal(readFunnelSession(memoryCookies()), null);
    assert.equal(isFunnelSessionId(createFunnelSessionId()), true);
  });
});

describe("ChatGPT funnel endpoint", () => {
  it("records only the ChatGPT click and ignores client identity", async () => {
    const recorded = [];
    const jar = memoryCookies();
    const db = {
      workspace: {
        findUnique: async ({ where }) => {
          assert.equal(where.clerkUserId, "user_1");
          return { id: "ws_server" };
        },
      },
    };

    const response = await handleChatgptFunnelPost({
      cookieStore: jar,
      userId: "user_1",
      db,
      record: async (input) => {
        recorded.push(input);
        return { ok: true, recorded: true, reason: null, id: "hidden" };
      },
    });
    const body = await response.json();

    assert.deepEqual(body, { ok: true });
    assert.equal(JSON.stringify(body).includes("ws_server"), false);
    assert.equal(JSON.stringify(body).includes(recorded[0].sessionId), false);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].event, "chatgpt_plugin_cta_click");
    assert.equal(recorded[0].workspaceId, "ws_server");
    assert.equal(isFunnelSessionId(recorded[0].sessionId), true);
    assert.equal(recorded[0].event === "pro_checkout_started", false);
  });

  it("records an anonymous click with a null workspace", async () => {
    const recorded = [];
    const response = await handleChatgptFunnelPost({
      cookieStore: memoryCookies(),
      userId: null,
      db: {
        workspace: {
          findUnique: async () => {
            throw new Error("should not look up");
          },
        },
      },
      record: async (input) => {
        recorded.push(input);
        return { ok: true, recorded: true };
      },
    });
    assert.equal((await response.json()).ok, true);
    assert.equal(recorded[0].workspaceId, null);
    assert.equal(recorded[0].event, "chatgpt_plugin_cta_click");
  });

  it("still returns ok when persistence throws", async () => {
    const response = await handleChatgptFunnelPost({
      cookieStore: memoryCookies(),
      record: async () => {
        throw new Error("db down");
      },
    });
    assert.deepEqual(await response.json(), { ok: true });
  });

  it("does not create a workspace when lookup fails", async () => {
    const id = await lookupSignedInWorkspaceId({
      userId: "user_1",
      db: {
        workspace: {
          findUnique: async () => {
            const err = new Error("down");
            err.code = "P1001";
            throw err;
          },
        },
      },
    });
    assert.equal(id, null);
  });

  it("route does not read a client event or workspace id", () => {
    const route = fs.readFileSync(path.join(repoRoot, "app/api/funnel/route.js"), "utf8");
    assert.equal(route.includes("req.json"), false);
    assert.equal(route.includes("body.event"), false);
    assert.equal(route.includes("body.workspaceId"), false);
    assert.equal(route.includes("export async function GET"), false);
    assert.equal(route.includes("export async function POST"), true);
  });
});

describe("homepage click", () => {
  it("posts without a body and does not throw when the request fails", async () => {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      throw new Error("offline");
    };
    try {
      notifyChatgptPluginClick();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "/api/funnel");
      assert.equal(calls[0].init.method, "POST");
      assert.equal(calls[0].init.keepalive, true);
      assert.equal(calls[0].init.credentials, "same-origin");
      assert.equal(Object.hasOwn(calls[0].init, "body"), false);
      globalThis.fetch = () => {
        throw new Error("sync failure");
      };
      assert.doesNotThrow(() => notifyChatgptPluginClick());
    } finally {
      globalThis.fetch = original;
    }

    const page = fs.readFileSync(path.join(repoRoot, "app/page.js"), "utf8");
    assert.match(page, /track\("chatgpt_plugin_cta_click"/);
    assert.match(page, /notifyChatgptPluginClick\(\)/);
    assert.match(page, /href=\{CHATGPT_PLUGIN_URL\}/);
    assert.equal(page.includes("preventDefault"), false);
    assert.equal(page.includes("await notifyChatgptPluginClick"), false);
    assert.equal(page.includes("await fetch(\"/api/funnel\")"), false);
  });
});

describe("trusted checkout start", () => {
  it("records the server workspace and a valid session only", async () => {
    const recorded = [];
    const sessionId = createFunnelSessionId();
    const result = await recordTrustedCheckoutStart({
      workspaceId: "ws_trusted",
      sessionId,
      record: async (input) => {
        recorded.push(input);
        return { ok: true, recorded: true, reason: null, id: "fe_1" };
      },
    });
    assert.equal(result.recorded, true);
    assert.equal(recorded[0].event, "pro_checkout_started");
    assert.equal(recorded[0].workspaceId, "ws_trusted");
    assert.equal(recorded[0].sessionId, sessionId);

    const dropped = await recordTrustedCheckoutStart({
      workspaceId: "ws_trusted",
      sessionId: "ws_from_cookie",
      record: async (input) => input,
    });
    assert.equal(dropped.sessionId, null);
  });

  it("does not record without a workspace and does not throw when storage fails", async () => {
    const rejected = await recordTrustedCheckoutStart({ workspaceId: "  " });
    assert.equal(rejected.recorded, false);
    assert.equal(rejected.reason, "rejected");

    let continued = false;
    const failed = await recordTrustedCheckoutStart({
      workspaceId: "ws_1",
      record: async () => {
        throw new Error("db down");
      },
    });
    continued = true;
    assert.equal(continued, true);
    assert.equal(failed.reason, "persist_failed");
    assert.equal(failed.recorded, false);
  });

  it("checkout route records only after the request is allowed to create checkout", () => {
    const src = fs.readFileSync(path.join(repoRoot, "app/api/billing/checkout/route.js"), "utf8");
    const recordAt = src.indexOf("recordTrustedCheckoutStart(");
    assert.ok(recordAt > 0);
    const before = src.slice(0, recordAt);
    assert.match(before, /if \(!gate\.ok\) return gate\.response/);
    assert.match(before, /requested !== PLAN_IDS\.PRO/);
    assert.match(before, /alreadyActive/);
    assert.match(before, /!getPaddleProPriceId\(\)/);
    assert.match(before, /!isPaddleConfigured\(\)/);
    assert.match(before, /if \(!workspace\?\.id\)/);
    assert.match(src.slice(recordAt), /createPaddleCheckoutTransaction\(/);
    assert.equal(src.includes("body.workspaceId"), false);
    assert.equal(src.includes("workspaceId: workspace.id"), true);
  });

  it("repeated checkout starts stay one distinct workspace and one conversion", async () => {
    const db = fakeDb();
    await recordTrustedCheckoutStart({ workspaceId: "ws_1", record: (input) => db.funnelEvent.create({ data: input }) });
    await recordTrustedCheckoutStart({ workspaceId: "ws_1", record: (input) => db.funnelEvent.create({ data: input }) });
    db.seedPaid({
      workspaceId: "ws_1",
      firstPaidAt: new Date(Date.now() + 1000).toISOString(),
      firstPaidAmount: 1900,
      firstPaidCurrency: "USD",
    });

    const summary = await getGrowthFunnelSummary(db, {});
    assert.equal(summary.proCheckoutStarts, 2);
    assert.equal(summary.distinctCheckoutWorkspaces, 1);
    assert.equal(summary.checkoutToPaid, 1);
    assert.equal(summary.firstPaidCustomers, 1);
  });
});
