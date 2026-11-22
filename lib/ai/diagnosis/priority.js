import { PRIORITY_BANDS, PRIORITY_WEIGHTS } from "./config.js";

/**
 * Compute a 0–100 severity score from weighted hints.
 * @param {{ recommendationImpact?: number, providerCoverage?: number, competitorGap?: number, frequency?: number }} hints
 */
export function severityScore(hints = {}) {
  const w = PRIORITY_WEIGHTS;
  const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0));
  const total =
    clamp(hints.recommendationImpact) * w.recommendationImpact +
    clamp(hints.providerCoverage) * w.providerCoverage +
    clamp(hints.competitorGap) * w.competitorGap +
    clamp(hints.frequency) * w.frequency;
  const denom = w.recommendationImpact + w.providerCoverage + w.competitorGap + w.frequency;
  return Math.round(total / denom);
}

/**
 * @param {number} score
 * @returns {"critical"|"high"|"medium"|"low"}
 */
export function priorityFromScore(score) {
  for (const band of PRIORITY_BANDS) {
    if (score >= band.min) return band.priority;
  }
  return "low";
}

/**
 * Assign priority + severityScore onto an issue draft.
 * @param {object} draft
 */
export function assignPriority(draft) {
  const score = severityScore(draft.severityHints || {});
  const priority = priorityFromScore(score);
  const { severityHints, ...rest } = draft;
  return { ...rest, priority, severityScore: score };
}

/**
 * Sort issues by priority then severity.
 * @param {Array<{ priority: string, severityScore?: number }>} issues
 */
export function sortIssues(issues) {
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  return [...issues].sort(
    (a, b) => (order[a.priority] ?? 9) - (order[b.priority] ?? 9) || (b.severityScore || 0) - (a.severityScore || 0)
  );
}
