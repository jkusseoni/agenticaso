import { aicreditsChat, getAicreditsConfig } from "../aicredits.js";
import { normalizeProviderResult, errorResult } from "../normalize.js";

export const PERPLEXITY_MODEL = "perplexity/sonar";

const SYSTEM = `You are a helpful shopping assistant with live web context. Recommend specific real brands/stores with brief reasons.
List recommendations in a numbered list when possible.
After your recommendations, append a single JSON object (no markdown fence) with this shape:
{"brands":[{"name":"Brand","position":1,"recommended":true}],"citations":["https://..."]}`;

/**
 * Perplexity provider via AICredits gateway (live web search model).
 * @type {import("../types.js").AIProvider}
 */
export const perplexityProvider = {
  id: "perplexity",
  name: "Perplexity",

  async runBuyerQuery(input) {
    const question = String(input?.buyerQuestion || "").trim();
    const brandName = String(input?.brandName || "").trim();
    const websiteUrl = String(input?.websiteUrl || "").trim();
    const started = Date.now();

    if (!getAicreditsConfig().configured) {
      return errorResult("perplexity", PERPLEXITY_MODEL, question, "Missing AICREDITS_API_KEY / AICREDITS_BASE_URL");
    }
    if (!question) {
      return errorResult("perplexity", PERPLEXITY_MODEL, question, "buyerQuestion is required");
    }

    try {
      const answer = await aicreditsChat(
        PERPLEXITY_MODEL,
        [
          { role: "system", content: SYSTEM },
          { role: "user", content: question },
        ],
        { temperature: 0.2, max_tokens: 700 }
      );
      return normalizeProviderResult({
        provider: "perplexity",
        model: PERPLEXITY_MODEL,
        question,
        answer,
        brandName,
        websiteUrl,
        latencyMs: Date.now() - started,
      });
    } catch (e) {
      return errorResult(
        "perplexity",
        PERPLEXITY_MODEL,
        question,
        e?.message || String(e),
        Date.now() - started
      );
    }
  },
};

export default perplexityProvider;
