import test from "node:test";
import assert from "node:assert/strict";
import {
  applySpendCharge,
  authorizeProviderAttempt,
  providerBudgetStorage,
  readProviderBudgetConfig,
  runBoundedProviderAttempts,
} from "../provider-budget.js";
import { aicreditsChat } from "../aicredits.js";

const enabled = {
  AI_PROVIDER_EXECUTION: "enabled",
  AI_PROVIDER_MAX_CALLS_PER_SCAN: "2",
  AI_PROVIDER_ESTIMATED_CENTS_PER_CALL: "5",
  AI_PROVIDER_MAX_CENTS_PER_SCAN: "10",
  AI_PROVIDER_MAX_CENTS_PER_DAY: "10",
  AI_PROVIDER_TIMEOUT_MS: "1000",
  AI_PROVIDER_MAX_RETRIES: "0",
};

test("external AI execution is disabled by default", () => {
  const config = readProviderBudgetConfig({});
  assert.equal(config.ok, true);
  assert.equal(config.enabled, false);
  assert.equal(config.killed, false);
});

test("kill switch disables execution", () => {
  const config = readProviderBudgetConfig({ ...enabled, AI_PROVIDER_KILL_SWITCH: "1" });
  assert.equal(config.enabled, false);
  assert.equal(config.killed, true);
});

test("invalid budget configuration fails closed", () => {
  const config = readProviderBudgetConfig({ ...enabled, AI_PROVIDER_MAX_CENTS_PER_DAY: "lots" });
  assert.equal(config.ok, false);
  assert.equal(config.reason, "provider_budget_unverified");
});

test("concurrent claims cannot pass the same last cent", async () => {
  const current = {
    scan: { spentCalls: 1, spentCents: 5, maxCalls: 2, maxCents: 10 },
    day: { spentCalls: 1, spentCents: 5 },
  };
  let lock = Promise.resolve();
  const claim = () => {
    const previous = lock;
    let release;
    lock = new Promise((resolve) => {
      release = resolve;
    });
    return previous.then(() => {
      const result = applySpendCharge(current, { cents: 5, dailyCents: 10 });
      if (result.ok) {
        current.scan = result.scan;
        current.day = result.day;
      }
      release();
      return result;
    });
  };
  const [first, second] = await Promise.all([claim(), claim()]);
  assert.equal([first.ok, second.ok].filter(Boolean).length, 1);
  assert.equal(current.day.spentCents, 10);
});

test("disabled execution does not call the provider", async () => {
  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("fetch must not run");
  };
  const previous = {
    base: process.env.AICREDITS_BASE_URL,
    key: process.env.AICREDITS_API_KEY,
    execution: process.env.AI_PROVIDER_EXECUTION,
  };
  process.env.AICREDITS_BASE_URL = "https://example.invalid";
  process.env.AICREDITS_API_KEY = "test-key";
  delete process.env.AI_PROVIDER_EXECUTION;
  try {
    await assert.rejects(() => aicreditsChat("openai/gpt-4o-mini", []), /ai_execution_disabled/);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = original;
    restoreEnv(previous);
  }
});

test("budget exceeded and missing reservation do not call the provider", async () => {
  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
  };
  const previous = snapshotEnv();
  Object.assign(process.env, enabled, {
    AICREDITS_BASE_URL: "https://example.invalid",
    AICREDITS_API_KEY: "test-key",
  });
  try {
    await assert.rejects(() => aicreditsChat("openai/gpt-4o-mini", []), /provider_budget_unverified/);
    await assert.rejects(() => providerBudgetStorage.run({
      scanId: "scan",
      config: readProviderBudgetConfig(),
      db: { $transaction: async () => ({ ok: false, reason: "daily_budget_exceeded" }) },
    }, () => aicreditsChat("openai/gpt-4o-mini", [])), /daily_budget_exceeded/);
  } finally {
    restoreSnapshot(previous);
    globalThis.fetch = original;
  }
  assert.equal(fetches, 0);
});

test("provider timeout stops waiting and kill switch blocks a reserved scan", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (_url, opts) => new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("should have aborted")), 5000);
    opts.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    });
  });
  const previous = snapshotEnv();
  Object.assign(process.env, enabled, {
    AI_PROVIDER_TIMEOUT_MS: "1000",
    AICREDITS_BASE_URL: "https://example.invalid",
    AICREDITS_API_KEY: "test-key",
  });
  const db = { $transaction: async (fn) => fn({
    $executeRaw: async () => 1,
    $queryRaw: async () => [{ spentCalls: 0, spentCents: 0, maxCalls: 2, maxCents: 10 }],
  }) };
  try {
    await providerBudgetStorage.run({
      scanId: "scan-timeout",
      day: "2026-11-20",
      config: readProviderBudgetConfig(),
      db,
    }, () => assert.rejects(aicreditsChat("openai/gpt-4o-mini", []), /timeout/));
    process.env.AI_PROVIDER_KILL_SWITCH = "1";
    const blocked = await authorizeProviderAttempt();
    assert.equal(blocked.allow, false);
    assert.equal(blocked.reason, "ai_provider_kill_switch");
    assert.equal(await runBoundedProviderAttempts(async () => "not-called").catch((error) => error.message), "ai_provider_kill_switch");
  } finally {
    restoreSnapshot(previous);
    globalThis.fetch = original;
  }
});

test("overlapping scans keep separate budget contexts", async () => {
  const previous = snapshotEnv();
  Object.assign(process.env, enabled);
  const charged = [];
  function db(expected) {
    return {
      $transaction: async (fn) => {
        const current = providerBudgetStorage.getStore();
        charged.push(current?.scanId);
        assert.equal(current?.scanId, expected);
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(providerBudgetStorage.getStore()?.scanId, expected);
        return fn({
          $executeRaw: async () => 1,
          $queryRaw: async () => [{ spentCalls: 0, spentCents: 0, maxCalls: 2, maxCents: 10 }],
        });
      },
    };
  }
  try {
    const config = readProviderBudgetConfig();
    const [left, right] = await Promise.all([
      providerBudgetStorage.run(
        { scanId: "scan-a", day: "2026-11-20", config, db: db("scan-a") },
        () => authorizeProviderAttempt()
      ),
      providerBudgetStorage.run(
        { scanId: "scan-b", day: "2026-11-20", config, db: db("scan-b") },
        () => authorizeProviderAttempt()
      ),
    ]);
    assert.equal(left.allow, true);
    assert.equal(right.allow, true);
    assert.deepEqual(charged.sort(), ["scan-a", "scan-b"]);
    assert.equal(providerBudgetStorage.getStore(), undefined);
  } finally {
    restoreSnapshot(previous);
  }
});

test("a nested provider call uses the inner scan budget", async () => {
  const previous = snapshotEnv();
  Object.assign(process.env, enabled);
  const charged = [];
  const db = {
    $transaction: async (fn) => {
      charged.push(providerBudgetStorage.getStore()?.scanId);
      return fn({
        $executeRaw: async () => 1,
        $queryRaw: async () => [{ spentCalls: 0, spentCents: 0, maxCalls: 2, maxCents: 10 }],
      });
    },
  };
  try {
    const config = readProviderBudgetConfig();
    const outer = { scanId: "outer-scan", day: "2026-11-20", config, db };
    const inner = { scanId: "inner-scan", day: "2026-11-20", config, db };
    await providerBudgetStorage.run(outer, async () => {
      const outerCharge = await authorizeProviderAttempt();
      assert.equal(outerCharge.allow, true);
      await providerBudgetStorage.run(inner, async () => {
        const innerCharge = await authorizeProviderAttempt();
        assert.equal(innerCharge.allow, true);
        assert.equal(providerBudgetStorage.getStore().scanId, "inner-scan");
      });
      assert.equal(providerBudgetStorage.getStore().scanId, "outer-scan");
    });
    assert.deepEqual(charged, ["outer-scan", "inner-scan"]);
    assert.equal(providerBudgetStorage.getStore(), undefined);
  } finally {
    restoreSnapshot(previous);
  }
});

test("permanent HTTP errors are charged once when a retry is allowed", async () => {
  for (const status of [400, 401]) {
    const observed = await observeProviderRetries(status);
    assert.equal(observed.events.join(","), "charge,fetch");
    assert.equal(observed.fetches, 1);
    assert.equal(observed.charges, 1);
    assert.match(observed.error, new RegExp(`\\b${status}\\b`));
  }
});

test("retryable HTTP 503 charges and authorizes the second request first", async () => {
  const observed = await observeProviderRetries(503);
  assert.deepEqual(observed.events, ["charge", "fetch", "charge", "fetch"]);
  assert.equal(observed.fetches, 2);
  assert.equal(observed.charges, 2);
  assert.match(observed.error, /\b503\b/);
});

test("timeout and network failures are retried and charged separately", async () => {
  const timeout = await observeProviderRetries("timeout");
  assert.deepEqual(timeout.events, ["charge", "fetch", "charge", "fetch"]);
  const network = await observeProviderRetries("network");
  assert.deepEqual(network.events, ["charge", "fetch", "charge", "fetch"]);
});

test("Gemini validation and block errors are not retried", async () => {
  for (const message of ["gemini_incomplete:MAX_TOKENS", "gemini_blocked:SAFETY"]) {
    const observed = await observeProviderRetries(message);
    assert.equal(observed.events.join(","), "charge,fetch");
    assert.equal(observed.error, message);
  }
});

test("a failed retry authorization sends no second request", async () => {
  const observed = await observeProviderRetries(503, { denyRetry: true });
  assert.deepEqual(observed.events, ["charge", "fetch", "charge"]);
  assert.equal(observed.fetches, 1);
  assert.equal(observed.error, "scan_budget_exceeded");
});

async function observeProviderRetries(failure, { denyRetry = false } = {}) {
  const events = [];
  const original = globalThis.fetch;
  const previous = snapshotEnv();
  Object.assign(process.env, enabled, {
    AI_PROVIDER_MAX_CALLS_PER_SCAN: "2",
    AI_PROVIDER_MAX_CENTS_PER_SCAN: "20",
    AI_PROVIDER_MAX_CENTS_PER_DAY: "20",
    AI_PROVIDER_MAX_RETRIES: "1",
    AICREDITS_BASE_URL: "https://example.invalid",
    AICREDITS_API_KEY: "test-key",
  });
  globalThis.fetch = async () => {
    events.push("fetch");
    if (failure === "timeout") {
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    }
    if (failure === "network") {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }
    if (typeof failure === "string") {
      throw new Error(failure);
    }
    return { ok: false, status: failure, text: async () => "denied" };
  };
  let charges = 0;
  const db = {
    $transaction: async (fn) => {
      events.push("charge");
      charges += 1;
      if (denyRetry && charges > 1) return { ok: false, reason: "scan_budget_exceeded" };
      return fn({
        $executeRaw: async () => 1,
        $queryRaw: async () => [{ spentCalls: 0, spentCents: 0, maxCalls: 2, maxCents: 20 }],
      });
    },
  };
  try {
    const error = await providerBudgetStorage.run({
      scanId: "retry-scan",
      day: "2026-11-21",
      config: readProviderBudgetConfig(),
      db,
    }, () => aicreditsChat("openai/gpt-4o-mini", []).catch((caught) => caught));
    return { events, fetches: events.filter((event) => event === "fetch").length, charges, error: error?.message };
  } finally {
    globalThis.fetch = original;
    restoreSnapshot(previous);
  }
}

function snapshotEnv() {
  return {
    AI_PROVIDER_EXECUTION: process.env.AI_PROVIDER_EXECUTION,
    AI_PROVIDER_KILL_SWITCH: process.env.AI_PROVIDER_KILL_SWITCH,
    AI_PROVIDER_MAX_CALLS_PER_SCAN: process.env.AI_PROVIDER_MAX_CALLS_PER_SCAN,
    AI_PROVIDER_ESTIMATED_CENTS_PER_CALL: process.env.AI_PROVIDER_ESTIMATED_CENTS_PER_CALL,
    AI_PROVIDER_MAX_CENTS_PER_SCAN: process.env.AI_PROVIDER_MAX_CENTS_PER_SCAN,
    AI_PROVIDER_MAX_CENTS_PER_DAY: process.env.AI_PROVIDER_MAX_CENTS_PER_DAY,
    AI_PROVIDER_TIMEOUT_MS: process.env.AI_PROVIDER_TIMEOUT_MS,
    AI_PROVIDER_MAX_RETRIES: process.env.AI_PROVIDER_MAX_RETRIES,
    AICREDITS_BASE_URL: process.env.AICREDITS_BASE_URL,
    AICREDITS_API_KEY: process.env.AICREDITS_API_KEY,
  };
}

function restoreSnapshot(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreEnv(previous) {
  if (previous.base === undefined) delete process.env.AICREDITS_BASE_URL;
  else process.env.AICREDITS_BASE_URL = previous.base;
  if (previous.key === undefined) delete process.env.AICREDITS_API_KEY;
  else process.env.AICREDITS_API_KEY = previous.key;
  if (previous.execution === undefined) delete process.env.AI_PROVIDER_EXECUTION;
  else process.env.AI_PROVIDER_EXECUTION = previous.execution;
}
