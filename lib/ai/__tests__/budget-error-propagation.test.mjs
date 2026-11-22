import test from "node:test";
import assert from "node:assert/strict";
import { identifyBrand, generateBuyerQueries, runMultiAiAudit } from "../audit.js";
import { runAllProviders, runProvider, PROVIDERS } from "../run-provider.js";
import { providerBudgetStorage, readProviderBudgetConfig } from "../provider-budget.js";
import { runVisibilityAuditV2 } from "../visibility-v2.js";

const enabled = {
  AI_PROVIDER_EXECUTION: "enabled",
  AI_PROVIDER_MAX_CALLS_PER_SCAN: "2",
  AI_PROVIDER_ESTIMATED_CENTS_PER_CALL: "5",
  AI_PROVIDER_MAX_CENTS_PER_SCAN: "20",
  AI_PROVIDER_MAX_CENTS_PER_DAY: "20",
  AI_PROVIDER_TIMEOUT_MS: "1000",
  AI_PROVIDER_MAX_RETRIES: "0",
  AICREDITS_BASE_URL: "https://example.invalid",
  AICREDITS_API_KEY: "test-key",
};

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
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  };
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function budgetError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

test("identifyBrand propagates a budget authorization failure", async () => {
  const previous = snapshotEnv();
  const original = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("fetch must not run");
  };
  Object.assign(process.env, enabled);
  delete process.env.GEMINI_API_KEY;
  try {
    await assert.rejects(
      () => identifyBrand({ domain: "example.com", contentBlob: "Example store" }),
      (error) => error.code === "provider_budget_unverified"
    );
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = original;
    restoreEnv(previous);
  }
});

test("identifyBrand still falls back after an ordinary provider failure", async () => {
  const previous = snapshotEnv();
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "down" });
  Object.assign(process.env, enabled);
  const db = {
    $transaction: async (fn) => fn({
      $executeRaw: async () => 1,
      $queryRaw: async () => [{ spentCalls: 0, spentCents: 0, maxCalls: 2, maxCents: 20 }],
    }),
  };
  try {
    const info = await providerBudgetStorage.run({
      scanId: "brand-ordinary",
      day: "2026-11-21",
      config: readProviderBudgetConfig(),
      db,
    }, () => identifyBrand({ domain: "example.com", contentBlob: "Example store" }));
    assert.equal(info.brand, "example");
  } finally {
    globalThis.fetch = original;
    restoreEnv(previous);
  }
});

test("generateBuyerQueries propagates a budget authorization failure", async () => {
  const previous = snapshotEnv();
  const original = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("fetch must not run");
  };
  Object.assign(process.env, enabled);
  const db = { $transaction: async () => ({ ok: false, reason: "daily_budget_exceeded" }) };
  try {
    await assert.rejects(
      () => providerBudgetStorage.run({
        scanId: "questions-budget",
        day: "2026-11-21",
        config: readProviderBudgetConfig(),
        db,
      }, () => generateBuyerQueries({ brand: "Example", category: "goods", whatTheySell: "goods", isEcommerce: true })),
      (error) => error.code === "daily_budget_exceeded"
    );
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = original;
    restoreEnv(previous);
  }
});

test("runProvider preserves a budget authorization error", async () => {
  const previous = snapshotEnv();
  const original = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("fetch must not run");
  };
  Object.assign(process.env, enabled);
  try {
    await assert.rejects(
      () => runProvider("openai", { brandName: "Example", websiteUrl: "https://example.com", buyerQuestion: "best goods" }),
      (error) => error.code === "provider_budget_unverified"
    );
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = original;
    restoreEnv(previous);
  }
});

test("runAllProviders propagates a budget failure and keeps an ordinary partial failure", async () => {
  const originals = {
    openai: PROVIDERS.openai.runBuyerQuery,
    perplexity: PROVIDERS.perplexity.runBuyerQuery,
    gemini: PROVIDERS.gemini.runBuyerQuery,
  };
  PROVIDERS.perplexity.runBuyerQuery = async () => ({ provider: "perplexity", error: null, answer: "ok" });
  PROVIDERS.gemini.runBuyerQuery = async () => ({ provider: "gemini", error: "ordinary failure", answer: "" });
  PROVIDERS.openai.runBuyerQuery = async () => {
    throw budgetError("scan_budget_exceeded");
  };
  try {
    await assert.rejects(
      () => runAllProviders({ brandName: "Example", websiteUrl: "https://example.com", buyerQuestion: "best goods" }),
      (error) => error.code === "scan_budget_exceeded"
    );
    PROVIDERS.openai.runBuyerQuery = async () => ({ provider: "openai", error: "model overloaded", answer: "" });
    const results = await runAllProviders({ brandName: "Example", websiteUrl: "https://example.com", buyerQuestion: "best goods" });
    assert.equal(results.length, 3);
    assert.equal(results.find((result) => result.provider === "openai").error, "model overloaded");
    assert.equal(results.find((result) => result.provider === "perplexity").error, null);
  } finally {
    PROVIDERS.openai.runBuyerQuery = originals.openai;
    PROVIDERS.perplexity.runBuyerQuery = originals.perplexity;
    PROVIDERS.gemini.runBuyerQuery = originals.gemini;
  }
});

test("runMultiAiAudit stops before the next question after a budget failure", async () => {
  const originals = {
    openai: PROVIDERS.openai.runBuyerQuery,
    perplexity: PROVIDERS.perplexity.runBuyerQuery,
    gemini: PROVIDERS.gemini.runBuyerQuery,
  };
  const seen = [];
  PROVIDERS.openai.runBuyerQuery = async (input) => {
    seen.push(input.buyerQuestion);
    throw budgetError("daily_budget_exceeded");
  };
  PROVIDERS.perplexity.runBuyerQuery = async () => ({ provider: "perplexity", error: null, answer: "ok" });
  PROVIDERS.gemini.runBuyerQuery = async () => ({ provider: "gemini", error: null, answer: "ok" });
  try {
    await assert.rejects(
      () => runMultiAiAudit({
        brandName: "Example",
        websiteUrl: "https://example.com",
        domain: "example.com",
        questions: ["first question", "second question"],
      }),
      (error) => error.code === "daily_budget_exceeded"
    );
    assert.deepEqual(seen, ["first question"]);
  } finally {
    PROVIDERS.openai.runBuyerQuery = originals.openai;
    PROVIDERS.perplexity.runBuyerQuery = originals.perplexity;
    PROVIDERS.gemini.runBuyerQuery = originals.gemini;
  }
});

function visibilityInput(extra = {}) {
  return {
    url: "https://example.com",
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
    ...extra,
  };
}

test("visibility v2 stops before provider calls when brand identification hits a budget error", async () => {
  const calls = [];
  const result = await runVisibilityAuditV2(visibilityInput(), {
    siteSignals: async () => ({ ok: true, title: "Example", desc: "Store", bodyText: "Store" }),
    identifyBrand: async () => {
      calls.push("brand");
      throw budgetError("provider_budget_unverified");
    },
    generateBuyerQueries: async () => {
      calls.push("questions");
      return ["should not run"];
    },
    runAllProviders: async () => {
      calls.push("providers");
      return [];
    },
    persistCompletedAudit: async () => {
      calls.push("persist");
      throw new Error("persist must not run");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.body.error, "provider_budget_unverified");
  assert.equal(result.body.persistence.saved, false);
  assert.deepEqual(calls, ["brand"]);
});

test("visibility v2 releases the reservation and does not persist a budget failure", async () => {
  const calls = [];
  const result = await runVisibilityAuditV2(visibilityInput({
    brand: "Example",
    question: "What does Example sell?",
  }), {
    siteSignals: async () => ({ ok: true, title: "Example", desc: "Store", bodyText: "Store" }),
    runAllProviders: async () => {
      calls.push("providers");
      throw budgetError("scan_budget_exceeded");
    },
    reserveUsageOperation: async (_db, _id, args) => {
      calls.push("reserve");
      return { ok: true, operationId: "budget-op", reserved: args.aiTests };
    },
    releaseUsageOperation: async () => {
      calls.push("release");
      return { settled: true };
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
  assert.equal(result.body.error, "scan_budget_exceeded");
  assert.equal(result.body.persistence.saved, false);
  assert.equal(result.body.usage.aiTestsCharged, 0);
  assert.deepEqual(calls, ["reserve", "providers", "release"]);
});
