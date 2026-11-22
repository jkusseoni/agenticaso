/**
 * Configurable diagnosis thresholds — do not scatter magic numbers.
 */
export const DIAGNOSIS_THRESHOLDS = Object.freeze({
  /** Recommendation share at/below → content/visibility issues */
  lowRecommendationShare: 25,
  /** Mention high but top3 low → ranking issue */
  mentionWithoutTop3: { mentionMin: 30, top3Max: 20 },
  /** Competitor recommendation gap (pp) considered material */
  competitorGapCritical: -25,
  competitorGapHigh: -10,
  /** Understood score below → entity/schema concerns */
  lowUnderstoodScore: 55,
  /** Found score below → discoverability (only if evaluated) */
  lowFoundScore: 55,
  /** Provider mention share at/below → provider-specific invisibility */
  providerInvisibleMention: 0,
  /** How many successful providers must miss brand for cross-AI issue */
  crossProviderMissMin: 2,
});

export const PRIORITY_WEIGHTS = Object.freeze({
  recommendationImpact: 40,
  providerCoverage: 25,
  competitorGap: 20,
  frequency: 15,
});

/** Map numeric severity score → priority label */
export const PRIORITY_BANDS = Object.freeze([
  { min: 80, priority: "critical" },
  { min: 60, priority: "high" },
  { min: 35, priority: "medium" },
  { min: 0, priority: "low" },
]);

export const ISSUE_CATEGORIES = Object.freeze([
  "content",
  "entity",
  "schema",
  "authority",
  "commerce",
  "ai_perception",
]);
