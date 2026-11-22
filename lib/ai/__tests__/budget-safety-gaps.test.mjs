import test from "node:test";
import assert from "node:assert/strict";
import { aicreditsChat } from "../aicredits.js";
import { providerBudgetStorage, readProviderBudgetConfig } from "../provider-budget.js";
import { runAllProviders } from "../run-provider.js";
import { runVisibilityAuditV2 } from "../visibility-v2.js";

const retryEnv = {
  AI_PROVIDER_EXECUTION: "enabled",
  AI_PROVIDER_MAX_CALLS_PER_SCAN: "4",
  AI_PROVIDER_ESTIMATED_CENTS_PER_CALL: "5",
  AI_PROVIDER_MAX_CENTS_PER_SCAN: "40",
  AI_PROVIDER_MAX_CENTS_PER_DAY: "40",
  AI_PROVIDER_TIMEOUT_MS: "1000",
  AI_PROVIDER_MAX_RETRIES: "1",
  AICREDITS_BASE_URL: "https://example.invalid",
  AICREDITS_API_KEY: "test-key",
};

test("a denied provider does not stop a sibling that has not yet authorized", async () => {
  const events = [];
  const original = globalThis.fetch;
  const previous = snapshotEnv();
  Object.assign(process.env, retryEnv, { AI_PROVIDER_MAX_RETRIES: "0" });
  let denied = false;
  globalThis.fetch = async () => {
    events.push(denied ? "sibling-fetch-after-denial" : "fetch-before-denial");
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "sibling answer" } }] }),
      text: async () => "",
    };
  };
  const db = {
    $transaction: async (fn) => {
      if (!denied) {
        denied = true;
        events.push("deny");
        return { ok: false, reason: "scan_budget_exceeded" };
      }
      events.push("sibling-authorize-after-denial");
      return fn({
        $executeRaw: async () => 1,
        $queryRaw: async () => [{ spentCalls: 0, spentCents: 0, maxCalls: 4, maxCents: 40 }],
      });
    },
  };
  try {
    await assert.rejects(
      () => providerBudgetStorage.run({
        scanId: "sibling-scan",
        day: "2026-11-21",
        config: readProviderBudgetConfig(),
        db,
      }, () => runAllProviders({
        brandName: "Example",
        websiteUrl: "https://example.com",
        buyerQuestion: "best goods",
      }, { providers: ["openai", "perplexity"] })),
      (error) => error.code === "scan_budget_exceeded"
    );
    assert.deepEqual(events, [
      "deny",
      "sibling-authorize-after-denial",
      "sibling-fetch-after-denial",
    ]);
  } finally {
    globalThis.fetch = original;
    restoreSnapshot(previous);
  }
});

test("HTTP 403, 404, 408, and 429 are charged once and not retried", async () => {
  for (const status of [403, 404, 408, 429]) {
    const observed = await observeStatus(status);
    assert.deepEqual(observed.events, ["charge", "fetch"], `status ${status}`);
    assert.equal(observed.charges, 1, `status ${status}`);
    assert.equal(observed.fetches, 1, `status ${status}`);
    assert.match(observed.error, new RegExp(`\\b${status}\\b`));
  }
});

test("visibility v2 keeps the budget error when reservation release fails", async () => {
  const calls = [];
  const result = await runVisibilityAuditV2(visibilityInput(), {
    siteSignals: async () => ({ ok: true, title: "Example", desc: "Store", bodyText: "Store" }),
    runAllProviders: async () => {
      calls.push("providers");
      const error = new Error("daily_budget_exceeded");
      error.code = "daily_budget_exceeded";
      throw error;
    },
    reserveUsageOperation: async (_db, _id, args) => {
      calls.push("reserve");
      return { ok: true, operationId: "budget-op", reserved: args.aiTests };
    },
    releaseUsageOperation: async () => {
      calls.push("release");
      throw new Error("release storage unavailable");
    },
    commitUsageOperation: async () => {
      calls.push("commit");
      throw new Error("commit must not run");
    },
    persistCompletedAudit: async () => {
      calls.push("persist");
      throw new Error("persist must not run");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.body.error, "daily_budget_exceeded");
  assert.equal(result.body.persistence.saved, false);
  assert.equal(result.body.persistence.auditId, null);
  assert.equal(result.body.usage.aiTestsCharged, 0);
  assert.equal(result.body.usage.billingStatus, "unconfirmed");
  assert.deepEqual(calls, ["reserve", "providers", "release"]);
});

async function observeStatus(status) {
  const events = [];
  const original = globalThis.fetch;
  const previous = snapshotEnv();
  Object.assign(process.env, retryEnv);
  globalThis.fetch = async () => {
    events.push("fetch");
    return { ok: false, status, text: async () => "denied" };
  };
  let charges = 0;
  const db = {
    $transaction: async (fn) => {
      events.push("charge");
      charges += 1;
      return fn({
        $executeRaw: async () => 1,
        $queryRaw: async () => [{ spentCalls: 0, spentCents: 0, maxCalls: 4, maxCents: 40 }],
      });
    },
  };
  try {
    const error = await providerBudgetStorage.run({
      scanId: "status-scan",
      day: "2026-11-21",
      config: readProviderBudgetConfig(),
      db,
    }, () => aicreditsChat("openai/gpt-4o-mini", []).catch((caught) => caught));
    return {
      events,
      charges,
      fetches: events.filter((event) => event === "fetch").length,
      error: error?.message,
    };
  } finally {
    globalThis.fetch = original;
    restoreSnapshot(previous);
  }
}

function visibilityInput() {
  return {
    url: "https://example.com",
    brand: "Example",
    question: "What does Example sell?",
    clerkUserId: "test-user",
    workspace: { id: "test-workspace", clerkUserId: "test-user" },
    prisma: {
      workspace: {
        findFirst: async ({ where }) =>
          where.id === "test-workspace" && where.clerkUserId === "test-user"
            ? { id: "test-workspace" }
            : null,
      },
      website: { findUnique: async () => ({ id: "site-test-1" }) },
    },
    entitlements: {
      planId: "pro",
      entitlements: { websites: 3, buyerQuestions: 5, aiTestsPerMonth: 3000, advancedCompetitors: true },
    },
    usage: { aiTests: 0, audits: 0 },
  };
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
