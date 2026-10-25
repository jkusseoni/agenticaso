/**
 * AI-visibility API: Paddle entitlement gate, atomic usage, provider failures, SSRF.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { getEntitlements } from "../../billing/entitlements.js";
import { fetchPublicPage } from "../fetch-page.js";
import { commitUsage } from "../../billing/usage.js";
import { handleVisibilityRequest, scoreVisibility, SEARCH_MODEL, VISIBILITY_TIMING } from "../handler.js";
import {
  createSafeLookup,
  isBlockedAddress,
  normalizeVisibilityTarget,
  parsePublicHttpUrl,
} from "../target.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DAY = 24 * 60 * 60 * 1000;

function proSubscription(overrides = {}) {
  return {
    plan: "pro",
    status: "active",
    provider: "paddle",
    providerSubscriptionId: "sub_paddle_1",
    currentPeriodEnd: new Date(Date.now() + 10 * DAY),
    ...overrides,
  };
}

function usageDb({ aiTests = 0, aiTestsReserved = 0, failReserve = false, failCommits = 0, failRereadAfterSettle = false } = {}) {
  const row = {
    id: "up_1",
    workspaceId: "ws_1",
    periodStart: new Date(),
    periodEnd: new Date(),
    aiTests,
    aiTestsReserved,
    audits: 0,
    monitoringRuns: 0,
  };
  const calls = [];
  const periods = [];
  let commitFailuresLeft = failCommits;
  let settled = false;
  return {
    row,
    calls,
    periods,
    usagePeriod: {
      async upsert({ where }) {
        periods.push(where.workspaceId_periodStart.periodStart.toISOString());
        return { ...row };
      },
      async update({ data }) {
        row.aiTestsReserved += data.aiTestsReserved.increment;
        return { ...row };
      },
      async findUnique() {
        if (failRereadAfterSettle && settled) {
          const error = new Error("secret-db-down");
          error.code = "P1001";
          throw error;
        }
        return { ...row };
      },
    },
    async $executeRaw(strings, ...values) {
      await Promise.resolve();
      const sql = strings.join("?");
      if (sql.includes('("aiTests" + "aiTestsReserved" +')) {
        calls.push("reserve");
        if (failReserve) {
          const error = new Error("secret-db-down");
          error.code = "P1001";
          throw error;
        }
        const [need, , , max] = values;
        if (row.aiTests + row.aiTestsReserved + need > max) return 0;
        row.aiTestsReserved += need;
        return 1;
      }
      if (sql.includes('"audits" = "audits" +')) {
        const [reserved, actual] = values;
        if (commitFailuresLeft > 0) {
          commitFailuresLeft -= 1;
          calls.push("commit:failed");
          const error = new Error("secret-db-down");
          error.code = "P1001";
          throw error;
        }
        calls.push(`commit:${reserved}:${actual}`);
        row.aiTestsReserved = Math.max(0, row.aiTestsReserved - reserved);
        row.aiTests += actual;
        settled = true;
        return 1;
      }
      const [reserved] = values;
      calls.push(`release:${reserved}`);
      row.aiTestsReserved = Math.max(0, row.aiTestsReserved - reserved);
      settled = true;
      return 1;
    },
  };
}

function gateFor(subscription, prisma, { userId = "user_pro", used = prisma?.row?.aiTests ?? 0, clerkPaid = false } = {}) {
  const entitlements = getEntitlements(subscription);
  return {
    ok: true,
    userId,
    clerkPaid,
    isPaid: entitlements.isPaid,
    entitlements,
    usage: { aiTests: used },
    workspace: { id: "ws_1" },
    prisma,
  };
}

/**
 * Fake provider. `failWeb` / `failMemory` are query indexes (or "all") whose answers fail.
 */
function fakeChat({ order = [], failWeb = [], failMemory = [], hang = [], onCall = null } = {}) {
  const calls = { id: 0, gen: 0, web: 0, memory: 0 };
  const signals = [];
  let webIndex = 0;
  let memIndex = 0;
  const fails = (list, i) => list === "all" || list.includes(i);
  // A provider that never answers and ignores its abort signal.
  const never = () => new Promise(() => {});
  const chat = async (model, messages, opts = {}) => {
    order.push("chat");
    if (opts.signal) signals.push(opts.signal);
    const system = messages[0].content;
    if (system.includes("You identify a business")) {
      calls.id += 1;
      onCall?.("setup");
      if (hang.includes("setup")) return never();
      return JSON.stringify({ brand: "Acme Mugs", category: "coffee mugs", whatTheySell: "mugs", isEcommerce: true });
    }
    if (system.includes("generate realistic buyer search queries")) {
      calls.gen += 1;
      onCall?.("setup");
      if (hang.includes("setup")) return never();
      return JSON.stringify(["q1", "q2", "q3", "q4", "q5"]);
    }
    if (opts.web) {
      assert.equal(model, SEARCH_MODEL);
      const i = webIndex++;
      calls.web += 1;
      onCall?.("web");
      if (hang.includes("web")) return never();
      if (fails(failWeb, i)) throw new Error("provider down with secret body");
      return "1. Acme Mugs — great\n2. Other Cups — fine";
    }
    const i = memIndex++;
    calls.memory += 1;
    onCall?.("memory");
    if (hang.includes("memory")) return never();
    if (fails(failMemory, i)) throw new Error("provider down");
    return i % 2 === 0 ? "Try Acme Mugs." : "Try Rival Co.";
  };
  return { chat, calls, signals };
}

function deps(prisma, { chat, order = [], ...rest } = {}) {
  return {
    chat,
    configured: true,
    fetchPage: async () => ({ ok: true, text: "<title>Acme Mugs</title><h1>Mugs</h1>" }),
    rateLimited: () => false,
    reserve: async (...args) => {
      order.push("reserve");
      const { reserveUsage } = await import("../../billing/usage.js");
      return reserveUsage(...args);
    },
    ...rest,
  };
}

async function readJson(res) {
  return { status: res.status, body: await res.json() };
}

describe("visibility entitlement gate", () => {
  it("returns 401 for a logged-out request without provider calls or usage", async () => {
    const prisma = usageDb();
    const { chat, calls } = fakeChat();
    const res = await readJson(await handleVisibilityRequest({
      gate: { ok: false },
      body: { url: "acme.com" },
      deps: deps(prisma, { chat }),
    }));
    assert.equal(res.status, 401);
    assert.equal(calls.id + calls.web + calls.memory, 0);
    assert.deepEqual(prisma.calls, []);
  });

  it("returns 402 for Free, expired, and Clerk-metadata-only users", async () => {
    const cases = [
      null,
      proSubscription({ currentPeriodEnd: new Date(Date.now() - DAY) }),
      proSubscription({ provider: "razorpay" }),
      proSubscription({ status: "trialing" }),
    ];
    for (const subscription of cases) {
      const prisma = usageDb();
      const { chat, calls } = fakeChat();
      const res = await readJson(await handleVisibilityRequest({
        gate: gateFor(subscription, prisma, { clerkPaid: true }),
        body: { url: "acme.com" },
        deps: deps(prisma, { chat }),
      }));
      assert.equal(res.status, 402);
      assert.equal(res.body.upgrade, true);
      assert.equal(typeof res.body.error, "string");
      assert.equal(calls.id + calls.web + calls.memory, 0);
      assert.deepEqual(prisma.calls, []);
    }
  });

  it("runs for an active Paddle Pro subscription and reserves before any provider call", async () => {
    const prisma = usageDb({ aiTests: 100 });
    const order = [];
    const { chat, calls } = fakeChat({ order });
    const res = await readJson(await handleVisibilityRequest({
      gate: gateFor(proSubscription(), prisma),
      body: { url: "https://www.acme.com/" },
      deps: deps(prisma, { chat, order }),
    }));
    assert.equal(res.status, 200);
    assert.equal(order[0], "reserve");
    assert.equal(calls.web, 5);
    assert.equal(calls.memory, 5);
    for (const key of ["domain", "brand", "category", "overall", "webSoV", "memSoV", "queriesRun", "verdict", "perQuery", "topCompetitors"]) {
      assert.ok(key in res.body, key);
    }
    assert.equal(res.body.domain, "acme.com");
    assert.equal(res.body.webSoV, 100);
    assert.equal(res.body.memSoV, 60);
    assert.equal(res.body.partial, false);
    assert.deepEqual(prisma.calls, ["reserve", "commit:10:10"]);
    assert.equal(prisma.row.aiTests, 110);
    assert.equal(prisma.row.aiTestsReserved, 0);
  });

  it("route uses the server-side Paddle gate and never Clerk metadata", () => {
    const route = fs.readFileSync(path.join(repoRoot, "app/api/visibility/route.js"), "utf8");
    assert.ok(route.includes("requireClerkUser({ requirePaid: true, withBilling: true })"));
    assert.ok(route.includes("handleVisibilityRequest"));
    assert.equal(route.includes("publicMetadata"), false);
    assert.equal(route.includes("clerkClient"), false);
    const handler = fs.readFileSync(path.join(repoRoot, "lib/visibility/handler.js"), "utf8");
    assert.equal(handler.includes("publicMetadata"), false);
  });
});

describe("visibility usage", () => {
  it("lets only one of two concurrent checks reserve the last allowance", async () => {
    const prisma = usageDb({ aiTests: 2990 });
    const { chat, calls } = fakeChat();
    const run = () => handleVisibilityRequest({
      gate: gateFor(proSubscription(), prisma),
      body: { url: "acme.com" },
      deps: deps(prisma, { chat }),
    });
    const results = await Promise.all([run(), run()]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 402]);
    assert.equal(calls.id, 1);
    assert.equal(calls.web + calls.memory, 10);
    assert.equal(prisma.row.aiTests, 3000);
    assert.equal(prisma.row.aiTestsReserved, 0);
  });

  it("returns 503 without provider calls when the usage reservation cannot be written", async () => {
    const prisma = usageDb({ failReserve: true });
    const { chat, calls } = fakeChat();
    const res = await readJson(await handleVisibilityRequest({
      gate: gateFor(proSubscription(), prisma),
      body: { url: "acme.com" },
      deps: deps(prisma, { chat }),
    }));
    assert.equal(res.status, 503);
    assert.equal(JSON.stringify(res.body).includes("secret-db-down"), false);
    assert.equal(calls.id + calls.web + calls.memory, 0);
  });

  it("returns 503 when the billing context has no workspace", async () => {
    const prisma = usageDb();
    const gate = { ...gateFor(proSubscription(), prisma), workspace: null };
    const { chat, calls } = fakeChat();
    const res = await handleVisibilityRequest({ gate, body: { url: "acme.com" }, deps: deps(prisma, { chat }) });
    assert.equal(res.status, 503);
    assert.equal(calls.id, 0);
  });
});

describe("visibility provider failures", () => {
  it("scores only answered queries and commits only successful answers", async () => {
    const prisma = usageDb();
    const { chat } = fakeChat({ failWeb: [0, 1] });
    const res = await readJson(await handleVisibilityRequest({
      gate: gateFor(proSubscription(), prisma),
      body: { url: "acme.com" },
      deps: deps(prisma, { chat }),
    }));
    assert.equal(res.status, 200);
    assert.equal(res.body.webSoV, 100);
    assert.equal(res.body.partial, true);
    assert.deepEqual(res.body.answers, { web: 3, memory: 5, expected: 5 });
    assert.equal(res.body.perQuery.filter((q) => q.webOk === false).length, 2);
    assert.deepEqual(prisma.calls, ["reserve", "commit:10:8"]);
    assert.equal(prisma.row.aiTests, 8);
    assert.equal(prisma.row.aiTestsReserved, 0);
  });

  it("returns 502 and releases the reservation when a provider returns no answers", async () => {
    for (const failure of [{ failMemory: "all" }, { failWeb: "all" }, { failWeb: "all", failMemory: "all" }]) {
      const prisma = usageDb({ aiTests: 7 });
      const { chat } = fakeChat(failure);
      const res = await readJson(await handleVisibilityRequest({
        gate: gateFor(proSubscription(), prisma),
        body: { url: "acme.com" },
        deps: deps(prisma, { chat }),
      }));
      assert.equal(res.status, 502);
      assert.equal(typeof res.body.error, "string");
      assert.equal("overall" in res.body, false);
      assert.deepEqual(prisma.calls, ["reserve", "release:10"]);
      assert.equal(prisma.row.aiTests, 7);
      assert.equal(prisma.row.aiTestsReserved, 0);
    }
  });

  it("scoreVisibility does not count a failed call as a missed mention", () => {
    const rows = [
      { query: "a", webOk: true, memOk: true, webMentioned: true, memMentioned: false, competitors: [] },
      { query: "b", webOk: false, memOk: true, webMentioned: false, memMentioned: true, competitors: [] },
    ];
    const score = scoreVisibility(rows);
    assert.equal(score.webSoV, 100);
    assert.equal(score.memSoV, 50);
    assert.equal(score.billable, 3);
    assert.equal(score.partial, true);
    assert.equal(scoreVisibility([]).ok, false);
  });
});

describe("visibility input and SSRF", () => {
  it("rejects private, local, non-http, credentialed, and non-default-port URLs before usage", async () => {
    const bad = [
      "",
      "localhost",
      "http://localhost",
      "http://127.0.0.1",
      "http://192.168.1.9",
      "http://[::1]/",
      "http://169.254.169.254/latest/meta-data",
      "ftp://example.com",
      "file:///etc/passwd",
      "http://user:pass@example.com",
      "http://example.com:8080",
      "printer.local",
      "metadata.google.internal",
      "nodot",
    ];
    for (const url of bad) {
      assert.equal(normalizeVisibilityTarget(url), null, url);
      const prisma = usageDb();
      const { chat, calls } = fakeChat();
      const res = await handleVisibilityRequest({
        gate: gateFor(proSubscription(), prisma),
        body: { url },
        deps: deps(prisma, { chat }),
      });
      assert.equal(res.status, 422, url);
      assert.equal(calls.id, 0);
      assert.deepEqual(prisma.calls, []);
    }
    assert.equal(normalizeVisibilityTarget("WWW.Acme.COM/shop").domain, "acme.com");
    assert.equal(parsePublicHttpUrl("https://acme.com:443/").href, "https://acme.com/");
  });

  it("classifies non-public addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "not-an-ip"]) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
    for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"]) {
      assert.equal(isBlockedAddress(ip), false, ip);
    }
  });

  it("refuses a hostname that resolves to a private address at connect time", async () => {
    const lookup = createSafeLookup((host, opts, cb) => cb(null, [{ address: "10.0.0.5", family: 4 }]));
    const blocked = await new Promise((resolve) => lookup("rebind.example", { all: true }, (err) => resolve(err)));
    assert.equal(blocked.code, "BLOCKED_ADDRESS");

    const allow = createSafeLookup((host, opts, cb) => cb(null, [{ address: "93.184.216.34", family: 4 }]));
    const single = await new Promise((resolve) => allow("acme.com", {}, (err, address, family) => resolve({ err, address, family })));
    assert.deepEqual(single, { err: null, address: "93.184.216.34", family: 4 });

    const res = await fetchPublicPage("http://rebind.example/", {
      lookup: createSafeLookup((host, opts, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }])),
      timeoutMs: 2000,
    });
    assert.deepEqual(res, { ok: false, reason: "blocked_address" });
  });

  it("revalidates every redirect hop", async () => {
    const redirectTo = (location) => async () => ({ status: 302, location, text: "" });
    for (const location of ["http://127.0.0.1/", "http://localhost/admin", "http://169.254.169.254/", "ftp://acme.com/", "http://acme.com:8443/"]) {
      const res = await fetchPublicPage("https://acme.com/", { request: redirectTo(location) });
      assert.deepEqual(res, { ok: false, reason: "blocked_redirect" }, location);
    }

    const loop = await fetchPublicPage("https://acme.com/", { request: redirectTo("/again") });
    assert.deepEqual(loop, { ok: false, reason: "too_many_redirects" });

    const seen = [];
    const ok = await fetchPublicPage("https://acme.com/", {
      request: async (url) => {
        seen.push(url.href);
        return seen.length === 1
          ? { status: 301, location: "https://www.acme.com/home", text: "" }
          : { status: 200, location: null, text: "<title>Acme</title>" };
      },
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.finalUrl, "https://www.acme.com/home");
    assert.deepEqual(seen, ["https://acme.com/", "https://www.acme.com/home"]);
  });

  it("blocks IPv4-compatible IPv6 (::/96), including loopback and metadata forms", async () => {
    for (const ip of ["::", "::1", "::7f00:1", "::127.0.0.1", "::a9fe:a9fe", "::169.254.169.254", "::a00:1", "::8.8.8.8", "0:0:0:0:0:0:7f00:1"]) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
    assert.equal(isBlockedAddress("::1:0:0:1"), false);

    const lookup = createSafeLookup((host, opts, cb) => cb(null, [{ address: "::7f00:1", family: 6 }]));
    const err = await new Promise((resolve) => lookup("compat.example", { all: true }, (e) => resolve(e)));
    assert.equal(err.code, "BLOCKED_ADDRESS");

    const mixed = createSafeLookup((host, opts, cb) => cb(null, [
      { address: "93.184.216.34", family: 4 },
      { address: "::a9fe:a9fe", family: 6 },
    ]));
    const mixedErr = await new Promise((resolve) => mixed("dual.example", { all: true }, (e) => resolve(e)));
    assert.equal(mixedErr.code, "BLOCKED_ADDRESS");
  });

  it("stops a page fetch when the caller aborts", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await fetchPublicPage("https://acme.com/", {
      signal: ctrl.signal,
      request: async () => ({ status: 200, location: null, text: "never" }),
    });
    assert.deepEqual(res, { ok: false, reason: "aborted" });
  });
});

const FAST = { totalMs: 400, minStartMs: 0, pageMs: 50, setupMs: 50, providerMs: 2000 };

describe("visibility deadline and cancellation", () => {
  it("keeps the configured budget under the 60s route limit", () => {
    const route = fs.readFileSync(path.join(repoRoot, "app/api/visibility/route.js"), "utf8");
    assert.match(route, /export const maxDuration = 60;/);
    assert.ok(route.includes("startedAt"));
    assert.ok(route.includes("req.signal"));
    assert.ok(VISIBILITY_TIMING.totalMs <= 50_000);
    assert.ok(VISIBILITY_TIMING.pageMs + 2 * VISIBILITY_TIMING.setupMs < VISIBILITY_TIMING.totalMs);
    assert.ok(VISIBILITY_TIMING.minStartMs < VISIBILITY_TIMING.totalMs);
  });

  it("finishes by the deadline and releases usage when providers hang", async () => {
    const prisma = usageDb({ aiTests: 3 });
    const { chat, signals } = fakeChat({ hang: ["web", "memory"] });
    const started = Date.now();
    const res = await readJson(await handleVisibilityRequest({
      gate: gateFor(proSubscription(), prisma),
      body: { url: "acme.com" },
      deps: deps(prisma, { chat, timing: FAST }),
    }));
    const elapsed = Date.now() - started;
    assert.equal(res.status, 502);
    assert.ok(elapsed < 1500, `took ${elapsed}ms`);
    assert.deepEqual(prisma.calls, ["reserve", "release:10"]);
    assert.equal(prisma.row.aiTests, 3);
    assert.equal(prisma.row.aiTestsReserved, 0);
    assert.ok(signals.length >= 10);
    assert.ok(signals.every((s) => s.aborted), "every provider call was told to stop");
  });

  it("falls back when setup calls and the page fetch hang, and still finishes", async () => {
    const prisma = usageDb();
    const { chat } = fakeChat({ hang: ["setup"] });
    const res = await readJson(await handleVisibilityRequest({
      gate: gateFor(proSubscription(), prisma),
      body: { url: "acme.com" },
      deps: deps(prisma, {
        chat,
        timing: { ...FAST, totalMs: 2000 },
        fetchPage: () => new Promise(() => {}),
      }),
    }));
    assert.equal(res.status, 200);
    assert.ok(res.body.perQuery[0].query.startsWith("best "));
    assert.deepEqual(prisma.calls, ["reserve", "commit:10:10"]);
    assert.equal(prisma.row.aiTestsReserved, 0);
  });

  it("releases usage and stops provider work when the client disconnects", async () => {
    const prisma = usageDb({ aiTests: 5 });
    const ctrl = new AbortController();
    const { chat, signals } = fakeChat({
      hang: ["web", "memory"],
      onCall: (kind) => { if (kind === "web") ctrl.abort(); },
    });
    const res = await readJson(await handleVisibilityRequest({
      gate: gateFor(proSubscription(), prisma),
      body: { url: "acme.com" },
      deps: deps(prisma, { chat, signal: ctrl.signal, timing: { ...FAST, totalMs: 10_000, providerMs: 10_000 } }),
    }));
    assert.equal(res.status, 503);
    assert.match(res.body.error, /cancelled/i);
    assert.deepEqual(prisma.calls, ["reserve", "release:10"]);
    assert.equal(prisma.row.aiTests, 5);
    assert.equal(prisma.row.aiTestsReserved, 0);
    assert.ok(signals.filter((s) => s.aborted).length >= 1);
  });

  it("does not reserve or call providers when too little time is left", async () => {
    const prisma = usageDb();
    const { chat, calls } = fakeChat();
    const res = await handleVisibilityRequest({
      gate: gateFor(proSubscription(), prisma),
      body: { url: "acme.com" },
      deps: deps(prisma, { chat, startedAt: 0, clock: () => 30_000 }),
    });
    assert.equal(res.status, 503);
    assert.deepEqual(prisma.calls, []);
    assert.equal(calls.id + calls.web + calls.memory, 0);
  });

  it("does not reserve when the request is already cancelled", async () => {
    const prisma = usageDb();
    const ctrl = new AbortController();
    ctrl.abort();
    const { chat, calls } = fakeChat();
    const res = await handleVisibilityRequest({
      gate: gateFor(proSubscription(), prisma),
      body: { url: "acme.com" },
      deps: deps(prisma, { chat, signal: ctrl.signal }),
    });
    assert.equal(res.status, 503);
    assert.deepEqual(prisma.calls, []);
    assert.equal(calls.id, 0);
  });
});

describe("visibility settlement", () => {
  it("settles in the reservation's billing period across a UTC month boundary", async () => {
    const prisma = usageDb();
    const times = [new Date("2026-09-30T23:59:59.900Z"), new Date("2026-10-01T00:00:05.000Z")];
    let n = 0;
    const { chat } = fakeChat();
    const res = await handleVisibilityRequest({
      gate: gateFor(proSubscription(), prisma),
      body: { url: "acme.com" },
      deps: deps(prisma, { chat, now: () => times[Math.min(n++, times.length - 1)] }),
    });
    assert.equal(res.status, 200);
    assert.ok(prisma.periods.length >= 2);
    assert.ok(prisma.periods.every((p) => p === "2026-09-01T00:00:00.000Z"), prisma.periods.join(","));
    assert.equal(prisma.row.aiTestsReserved, 0);
  });

  it("retries a failed commit once and charges exactly once", async () => {
    const prisma = usageDb({ failCommits: 1 });
    const { chat } = fakeChat();
    const res = await handleVisibilityRequest({
      gate: gateFor(proSubscription(), prisma),
      body: { url: "acme.com" },
      deps: deps(prisma, { chat }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(prisma.calls, ["reserve", "commit:failed", "commit:10:10"]);
    assert.equal(prisma.row.aiTests, 10);
    assert.equal(prisma.row.aiTestsReserved, 0);
  });

  it("releases the hold when commit keeps failing, so nothing stays reserved", async () => {
    const prisma = usageDb({ failCommits: 2 });
    const { chat } = fakeChat();
    const res = await readJson(await handleVisibilityRequest({
      gate: gateFor(proSubscription(), prisma),
      body: { url: "acme.com" },
      deps: deps(prisma, { chat }),
    }));
    assert.equal(res.status, 503);
    assert.match(res.body.error, /billing settlement failed/i);
    assert.equal("overall" in res.body, false);
    assert.deepEqual(prisma.calls, ["reserve", "commit:failed", "commit:failed", "release:10"]);
    assert.equal(prisma.row.aiTests, 0);
    assert.equal(prisma.row.aiTestsReserved, 0);
  });

  it("releases the hold when the analysis throws unexpectedly", async () => {
    const prisma = usageDb({ aiTests: 2 });
    const { chat, calls } = fakeChat();
    const brokenPage = { ok: true, get text() { throw new Error("parser blew up"); } };
    const res = await readJson(await handleVisibilityRequest({
      gate: gateFor(proSubscription(), prisma),
      body: { url: "acme.com" },
      deps: deps(prisma, { chat, fetchPage: async () => brokenPage }),
    }));
    assert.equal(res.status, 500);
    assert.equal(calls.web + calls.memory, 0);
    assert.deepEqual(prisma.calls, ["reserve", "release:10"]);
    assert.equal(prisma.row.aiTests, 2);
    assert.equal(prisma.row.aiTestsReserved, 0);
  });

  it("does not retry a commit whose update applied but whose re-read failed", async () => {
    const prisma = usageDb({ aiTestsReserved: 10, failRereadAfterSettle: true });
    const result = await commitUsage(prisma, "ws_1", { reservedAiTests: 10, actualAiTests: 8 });
    assert.equal(result, null);
    assert.equal(prisma.row.aiTests, 8);
    assert.equal(prisma.row.aiTestsReserved, 0);

    const handlerDb = usageDb({ failRereadAfterSettle: true });
    const { chat } = fakeChat();
    const res = await handleVisibilityRequest({
      gate: gateFor(proSubscription(), handlerDb),
      body: { url: "acme.com" },
      deps: deps(handlerDb, { chat }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(handlerDb.calls, ["reserve", "commit:10:10"]);
    assert.equal(handlerDb.row.aiTests, 10);
  });
});
