/**
 * Configurable monitoring alert thresholds.
 * Do not scatter magic numbers elsewhere.
 */
export const ALERT_THRESHOLDS = Object.freeze({
  visibilityDropPp: 10,
  providerDropPp: 10,
  scoreChangePts: 10,
  visibilityRisePp: 10,
});

export const ALERT_TYPES = Object.freeze({
  VISIBILITY_DROP: "visibility_drop",
  VISIBILITY_RISE: "visibility_rise",
  PROVIDER_DROP: "provider_drop",
  COMPETITOR_OVERTAKE: "competitor_overtake",
  GAP_WIDENING: "gap_widening",
  GAP_SHRINKING: "gap_shrinking",
  SCORE_CHANGE: "score_change",
  NEW_COMPETITOR: "new_competitor",
  PERCEPTION_CHANGE: "perception_change",
  RUN_FAILED: "run_failed",
});

export const MONITORING_FREQUENCIES = Object.freeze(["weekly", "monthly"]);

export function isValidFrequency(freq) {
  return MONITORING_FREQUENCIES.includes(String(freq || "").toLowerCase());
}
