import { aicreditsChat, getAicreditsConfig } from "../aicredits.js";
import { normalizeProviderResult, errorResult } from "../normalize.js";

export const OPENAI_MODEL = "openai/gpt-4o-mini";

const SYSTEM = `You are a shopping assistant. Recommend specific real brands/stores with brief reasons.
Be concrete and list recommendations in a numbered list when possible.
After your recommendations, append a single JSON object (no markdown fence) with this shape:
{"brands":[{"name":"Brand","position":1,"recommended":true}],"citations":[]}`;

/**
 * ChatGPT / OpenAI provider via AICredits gateway.
 * @type {import("../types.js").AIProvider}
 */
export const openaiProvider = {
  id: "openai",
  name: "ChatGPT / OpenAI",

  async runBuyerQuery(input) {
    const question = String(input?.buyerQuestion || "").trim();
    const brandName = String(input?.brandName || "").trim();
    const websiteUrl = String(input?.websiteUrl || "").trim();
    const started = Date.now();

    if (!getAicreditsConfig().configured) {
      return errorResult("openai", OPENAI_MODEL, question, "Missing AICREDITS_API_KEY / AICREDITS_BASE_URL");
    }
    if (!question) {
      return errorResult("openai", OPENAI_MODEL, question, "buyerQuestion is required");
    }

    try {
      const answer = await aicreditsChat(
        OPENAI_MODEL,
        [
          { role: "system", content: SYSTEM },
          { role: "user", content: question },
        ],
        { temperature: 0.3, max_tokens: 700 }
      );
      return normalizeProviderResult({
        provider: "openai",
        model: OPENAI_MODEL,
        question,
        answer,
        brandName,
        websiteUrl,
        latencyMs: Date.now() - started,
      });
    } catch (e) {
      return errorResult("openai", OPENAI_MODEL, question, e?.message || String(e), Date.now() - started);
    }
  },
};

export default openaiProvider;
