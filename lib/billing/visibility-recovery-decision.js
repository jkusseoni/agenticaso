/**
 * Pure validation for a human-reviewed visibility billing recovery decision.
 * This module does not mutate operations or record an approval. It prepares
 * an auditable decision only; execution requires a separate authorized flow.
 */
export function prepareVisibilityRecoveryDecision({
  operationId, workspaceId, reviewerId, decision, evidence, reason,
}) {
  if (![operationId, workspaceId, reviewerId, reason].every(
    (value) => typeof value === "string" && value.trim().length > 0
  )) throw new TypeError("Recovery decision requires operation, workspace, reviewer and reason");
  if (!["settle", "release", "hold"].includes(decision)) {
    throw new TypeError("Unsupported recovery decision");
  }
  if (!Array.isArray(evidence) || evidence.length === 0 ||
      evidence.some((item) => typeof item !== "string" || !item.trim())) {
    throw new TypeError("Recovery decision requires evidence references");
  }
  if (decision === "settle") {
    throw new Error("Settlement requires independently verified provider usage; execution is not enabled");
  }
  if (decision === "release") {
    throw new Error("Release requires independently verified no-usage evidence; execution is not enabled");
  }
  return Object.freeze({
    operationId, workspaceId, reviewerId, decision,
    evidence: Object.freeze([...evidence]), reason,
    executionAllowed: false,
  });
}
