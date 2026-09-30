/**
 * Shared observed-evidence record for Growth extractors (no persistence).
 */

export const VERIFICATION_OBSERVED = "observed";

/**
 * @param {{
 *   claim: string,
 *   sourceUrl?: string|null,
 *   sourceType: string,
 *   observedData: string,
 *   confidence?: number,
 *   extractor: string,
 * }} fields
 */
export function observedEvidence(fields) {
  return {
    claim: String(fields.claim || ""),
    sourceUrl: fields.sourceUrl || null,
    sourceType: String(fields.sourceType || "html"),
    observedData: String(fields.observedData || "").slice(0, 500),
    confidence: typeof fields.confidence === "number" ? fields.confidence : 0.7,
    verificationStatus: VERIFICATION_OBSERVED,
    extractor: String(fields.extractor || "unknown"),
  };
}

export function sliceSnippet(value, max = 280) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}
