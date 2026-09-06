import { openaiProvider } from "./providers/openai.js";
import { perplexityProvider } from "./providers/perplexity.js";
import { geminiProvider } from "./providers/gemini.js";
import { errorResult } from "./normalize.js";

/** @type {Record<string, import("./types.js").AIProvider>} */
export const PROVIDERS = {
  openai: openaiProvider,
  perplexity: perplexityProvider,
  gemini: geminiProvider,
};

/**
 * Run a single named provider against a buyer query.
 * Never throws — failures become error results.
 *
 * @param {import("./types.js").ProviderId} providerId
 * @param {import("./types.js").BuyerQueryInput} input
 * @returns {Promise<import("./types.js").AIProviderResult>}
 */
export async function runProvider(providerId, input) {
  const provider = PROVIDERS[providerId];
  const question = String(input?.buyerQuestion || "");
  if (!provider) {
    return errorResult(providerId || "openai", "unknown", question, `Unknown provider: ${providerId}`);
  }
  try {
    return await provider.runBuyerQuery(input);
  } catch (e) {
    return errorResult(provider.id, "unknown", question, e?.message || String(e));
  }
}

/**
 * Execute OpenAI, Perplexity, and Gemini for the SAME buyer question.
 * Uses Promise.allSettled so one failure never fails the whole audit.
 *
 * @param {import("./types.js").BuyerQueryInput} input
 * @param {{ providers?: import("./types.js").ProviderId[] }} [opts]
 * @returns {Promise<import("./types.js").AIProviderResult[]>}
 */
export async function runAllProviders(input, opts = {}) {
  const ids = opts.providers || ["openai", "perplexity", "gemini"];
  const settled = await Promise.allSettled(ids.map((id) => runProvider(id, input)));

  return settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    return errorResult(ids[i], "unknown", String(input?.buyerQuestion || ""), s.reason?.message || String(s.reason));
  });
}

export { openaiProvider, perplexityProvider, geminiProvider };
