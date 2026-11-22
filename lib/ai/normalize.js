import { detectBrand } from "./brand.js";
import { extractCompetitors, tryParseStructuredAppendix } from "./competitors.js";

/**
 * Build an empty / error provider result.
 * @param {import("./types.js").ProviderId} provider
 * @param {string} model
 * @param {string} question
 * @param {string|null} error
 * @param {number} [latencyMs]
 * @returns {import("./types.js").AIProviderResult}
 */
export function errorResult(provider, model, question, error, latencyMs = 0) {
  return {
    provider,
    model,
    question,
    answer: "",
    brandMentioned: false,
    brandPosition: null,
    recommended: false,
    competitors: [],
    citations: [],
    confidence: null,
    latencyMs,
    error: error || "Unknown provider error",
  };
}

/**
 * Normalize a raw model answer into the shared AIProviderResult shape.
 *
 * @param {object} opts
 * @param {import("./types.js").ProviderId} opts.provider
 * @param {string} opts.model
 * @param {string} opts.question
 * @param {string} opts.answer
 * @param {string} opts.brandName
 * @param {string} [opts.websiteUrl]
 * @param {string[]} [opts.citations]
 * @param {number} opts.latencyMs
 * @param {string|null} [opts.error]
 * @returns {import("./types.js").AIProviderResult}
 */
export function normalizeProviderResult({
  provider,
  model,
  question,
  answer,
  brandName,
  websiteUrl = "",
  citations = [],
  latencyMs,
  error = null,
}) {
  if (error) {
    return errorResult(provider, model, question, error, latencyMs);
  }

  const text = String(answer || "");
  const brand = detectBrand(text, brandName, websiteUrl);
  const competitors = extractCompetitors(text, brandName).filter(
    (c) => c.name.toLowerCase() !== String(brandName || "").toLowerCase()
  );

  const structured = tryParseStructuredAppendix(text);
  const mergedCitations = [
    ...new Set([...(citations || []), ...((structured && structured.citations) || [])].map(String).filter(Boolean)),
  ];

  // Confidence: higher when structured appendix present + brand clearly ranked
  let confidence = 0.55;
  if (structured?.brands?.length) confidence += 0.2;
  if (brand.mentioned) confidence += 0.1;
  if (brand.position != null) confidence += 0.05;
  if (competitors.length) confidence += 0.05;
  confidence = Math.min(0.95, Math.round(confidence * 100) / 100);

  return {
    provider,
    model,
    question,
    answer: text,
    brandMentioned: brand.mentioned,
    brandPosition: brand.position,
    recommended: brand.recommended,
    competitors,
    citations: mergedCitations,
    confidence,
    latencyMs: latencyMs || 0,
    error: null,
  };
}
