import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rootUrl = pathToFileURL(root + path.sep).href;

function aliasFileUrl(specifier) {
  return pathToFileURL(path.join(root, specifier.slice(2))).href;
}

globalThis.__legacyBudget = { calls: [], resolved: [] };

const mocks = {
  "@/lib/db/auth-gate": `
    export async function requireClerkUser() {
      return { ok: true, userId: "user-1" };
    }
  `,
  "@/lib/db": `
    export function getPrisma() {
      return {
        $transaction: async (fn) => fn({
          $executeRaw: async () => 1,
          $queryRaw: async () => [],
        }),
      };
    }
  `,
  "@/lib/scan/safe-fetch.js": `
    export async function safeFetchText() {
      globalThis.__legacyBudget.calls.push("site");
      return { ok: true, text: "<title>Example</title><p>Example store</p>" };
    }
  `,
  "@/lib/ai/aicredits.js": `
    export function getAicreditsConfig() {
      return { configured: true, base: "https://example.invalid", key: "test-key" };
    }
    export async function aicreditsChat() {
      globalThis.__legacyBudget.calls.push("chat");
      const error = new Error("daily_budget_exceeded");
      error.code = "daily_budget_exceeded";
      throw error;
    }
  `,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const url = aliasFileUrl(specifier);
      globalThis.__legacyBudget.resolved.push({
        specifier,
        url,
        parent: context.parentURL || null,
      });
      if (Object.hasOwn(mocks, specifier)) {
        return {
          url: "data:text/javascript," + encodeURIComponent(mocks[specifier]),
          shortCircuit: true,
        };
      }
      return nextResolve(url, context);
    }
    return nextResolve(specifier, context);
  },
});

const previous = {
  AI_PROVIDER_EXECUTION: process.env.AI_PROVIDER_EXECUTION,
  AICREDITS_BASE_URL: process.env.AICREDITS_BASE_URL,
  AICREDITS_API_KEY: process.env.AICREDITS_API_KEY,
  AI_PROVIDER_MAX_RETRIES: process.env.AI_PROVIDER_MAX_RETRIES,
};
process.env.AI_PROVIDER_EXECUTION = "enabled";
process.env.AICREDITS_BASE_URL = "https://example.invalid";
process.env.AICREDITS_API_KEY = "test-key";
process.env.AI_PROVIDER_MAX_RETRIES = "0";

const routeUrl = new URL("../../../app/api/visibility/route.js", import.meta.url).href;
const { POST } = await import(routeUrl);

test("legacy visibility route returns the budget error and makes no further provider call", async () => {
  const original = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("fetch must not run");
  };
  globalThis.__legacyBudget.calls = [];
  try {
    const response = await POST(new Request("http://localhost/api/visibility", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    }));
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error, "daily_budget_exceeded");
    assert.deepEqual(globalThis.__legacyBudget.calls, ["site", "chat"]);
    assert.equal(fetches, 0);

    const loaded = {
      route: routeUrl,
      budget: aliasFileUrl("@/lib/ai/provider-budget.js"),
      aicredits: aliasFileUrl("@/lib/ai/aicredits.js"),
    };
    for (const url of Object.values(loaded)) {
      assert.equal(url.startsWith(rootUrl), true, url);
      assert.equal(url.includes("agenticaso-p0-clerk-test"), false, url);
    }
    const budget = globalThis.__legacyBudget.resolved.find((item) => item.specifier === "@/lib/ai/provider-budget.js");
    const credits = globalThis.__legacyBudget.resolved.find((item) => item.specifier === "@/lib/ai/aicredits.js");
    assert.equal(budget?.url, loaded.budget);
    assert.equal(budget?.parent, loaded.route);
    assert.equal(credits?.url, loaded.aicredits);
    assert.equal(credits?.parent, loaded.route);
    assert.equal(globalThis.__legacyBudget.resolved.some((item) => String(item.url).includes("agenticaso-p0-clerk-test")), false);
    assert.equal(globalThis.__legacyBudget.resolved.some((item) => String(item.parent).includes("agenticaso-p0-clerk-test")), false);
  } finally {
    globalThis.fetch = original;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
