import { GoogleGenAI } from "@google/genai";
import { normalizeProviderResult, errorResult } from "../normalize.js";

export const GEMINI_MODEL = "gemini-2.0-flash";

const SYSTEM = `You are a shopping assistant. Recommend specific real brands/stores with brief reasons.
Be concrete and list recommendations in a numbered list when possible.
After your recommendations, append a single JSON object (no markdown fence) with this shape:
{"brands":[{"name":"Brand","position":1,"recommended":true}],"citations":[]}`;

/**
 * Google Gemini provider via official @google/genai SDK (server-side only).
 * @type {import("../types.js").AIProvider}
 */
export const geminiProvider = {
  id: "gemini",
  name: "Gemini",

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
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: `${SYSTEM}\n\nBuyer question: ${question}`,
        config: {
          temperature: 0.3,
          maxOutputTokens: 700,
        },
      });

      const answer = typeof response?.text === "string" ? response.text : String(response?.text || "");
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
      return errorResult("gemini", GEMINI_MODEL, question, e?.message || String(e), Date.now() - started);
    }
  },
};

export default geminiProvider;
