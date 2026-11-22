import { GoogleGenAI } from "@google/genai";
import { normalizeProviderResult, errorResult } from "../normalize.js";
import { rethrowBudgetAuthorizationError, runBoundedProviderAttempts } from "../provider-budget.js";

export const GEMINI_MODEL = "gemini-3.8-flash";

const SYSTEM = `You are a shopping assistant. Recommend specific real brands/stores with brief reasons.
Be concrete and list recommendations in a numbered list when possible.
After your recommendations, append a single JSON object (no markdown fence) with this shape:
{"brands":[{"name":"Brand","position":1,"recommended":true}],"citations":[]}`;

/**
 * Google Gemini provider via official @google/genai SDK (server-side only).
 * @type {import("../types.js").AIProvider}
 */
function readGeminiAnswer(response) {
  const candidates = response?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    const block = response?.promptFeedback?.blockReason;
    if (block) throw new Error(`gemini_blocked:${String(block).slice(0, 40)}`);
    throw new Error("gemini_missing_candidates");
  }
  const reason = candidates[0]?.finishReason;
  if (!reason) throw new Error("gemini_incomplete:missing_finish_reason");
  if (reason === "MAX_TOKENS") throw new Error("gemini_incomplete:MAX_TOKENS");
  if (reason !== "STOP") throw new Error(`gemini_blocked:${String(reason).slice(0, 40)}`);
  const text = typeof response?.text === "string" ? response.text.trim() : "";
  if (!text) throw new Error("gemini_empty_response");
  return text;
}

export const geminiProvider = {
  id: "gemini",
  name: "Gemini",

  createClient(apiKey) {
    return new GoogleGenAI({ apiKey });
  },

  async runBuyerQuery(input) {
    const question = String(input?.buyerQuestion || "").trim();
    const brandName = String(input?.brandName || "").trim();
    const websiteUrl = String(input?.websiteUrl || "").trim();
    const started = Date.now();
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return errorResult("gemini", GEMINI_MODEL, question, "Missing GEMINI_API_KEY");
    }
    if (!question) {
      return errorResult("gemini", GEMINI_MODEL, question, "buyerQuestion is required");
    }

    try {
      const answer = await runBoundedProviderAttempts(async ({ timeoutMs }) => {
        const ai = geminiProvider.createClient(apiKey);
        const response = await ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: `${SYSTEM}\n\nBuyer question: ${question}`,
          config: {
            maxOutputTokens: 1024,
            thinkingConfig: { thinkingLevel: "LOW" },
            abortSignal: AbortSignal.timeout(timeoutMs),
            httpOptions: {
              retryOptions: {
                attempts: 1,
              },
            },
          },
        });
        return readGeminiAnswer(response);
      });

      return normalizeProviderResult({
        provider: "gemini",
        model: GEMINI_MODEL,
        question,
        answer,
        brandName,
        websiteUrl,
        latencyMs: Date.now() - started,
      });
    } catch (e) {
      rethrowBudgetAuthorizationError(e);
      return errorResult("gemini", GEMINI_MODEL, question, e?.message || String(e), Date.now() - started);
    }
  },
};

export default geminiProvider;
