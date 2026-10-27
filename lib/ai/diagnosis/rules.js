import { DIAGNOSIS_THRESHOLDS } from "./config.js";

/**
 * @typedef {object} DiagnosisIssue
 * @property {string} id
 * @property {string} category
 * @property {string} title
 * @property {string} description
 * @property {string[]} evidence
 * @property {string} impact
 * @property {"critical"|"high"|"medium"|"low"} priority
 * @property {string[]} affectedProviders
 * @property {Record<string, number|string|null>} relatedMetrics
 * @property {number} [severityScore]
 */

/**
 * Extract successful provider ids that did not mention the brand.
 * @param {object} audit
 */
export function providersMissingBrand(audit) {
  const metrics = audit?.providerMetrics || {};
  const tests = audit?.aiTests || [];
  const ids = ["openai", "perplexity", "gemini"];
  const missing = [];

  for (const id of ids) {
    const m = metrics[id];
    const okTests = tests.filter((t) => t.provider === id && !t.error);
    const failedOnly = tests.some((t) => t.provider === id && t.error) && okTests.length === 0;

    // Prefer live test evidence; fall back to metrics
    if (okTests.length) {
      const mentioned = okTests.some((t) => t.brandMentioned);
      if (!mentioned) missing.push(id);
      continue;
    }
    if (failedOnly) continue; // don't treat failed provider as "not mentioned"
    if (m && typeof m.mentionShare === "number" && (m.tests || 0) > 0 && m.mentionShare <= DIAGNOSIS_THRESHOLDS.providerInvisibleMention) {
      missing.push(id);
    }
  }
  return missing;
}

/**
 * Rule set. Each rule returns null or a partial issue (priority filled later).
 * @type {Array<(audit: object) => Omit<DiagnosisIssue,"priority">|null>}
 */
export const DIAGNOSIS_RULES = [
  // Cross-provider invisibility
  (audit) => {
    const missing = providersMissingBrand(audit);
    if (missing.length < DIAGNOSIS_THRESHOLDS.crossProviderMissMin) return null;
    const brand = audit?.website?.brandName || audit?.website?.domain || "the brand";
    return {
      id: "cross_ai_invisibility",
      category: "content",
      title: `AI does not consistently recognize ${brand}`,
      description:
        "Multiple AI providers completed tests without mentioning the brand. Agents are unlikely to recommend you in this category until visibility improves.",
      evidence: [
        `Providers with no brand mention (successful tests only): ${missing.join(", ")}`,
        `Overall mentionShare=${audit.mentionShare ?? "n/a"}%`,
        `Overall recommendationShare=${audit.recommendationShare ?? "n/a"}%`,
      ],
      impact: "Low multi-AI discoverability reduces recommendation chance across assistants.",
      affectedProviders: missing,
      relatedMetrics: {
        mentionShare: audit.mentionShare ?? null,
        recommendationShare: audit.recommendationShare ?? null,
        missingProviderCount: missing.length,
      },
      severityHints: { recommendationImpact: 90, providerCoverage: (missing.length / 3) * 100, frequency: 80 },
    };
  },

  // Low recommendation share
  (audit) => {
    const rec = audit.recommendationShare;
    if (rec == null || rec > DIAGNOSIS_THRESHOLDS.lowRecommendationShare) return null;
    return {
      id: "low_recommendation_share",
      category: "content",
      title: "AI rarely recommends your brand",
      description:
        "Recommendation share is low across tested buyer questions. Comparison-ready content and clearer differentiation are likely needed.",
      evidence: [
        `recommendationShare=${rec}% (threshold ≤ ${DIAGNOSIS_THRESHOLDS.lowRecommendationShare}%)`,
        `mentionShare=${audit.mentionShare ?? "n/a"}%`,
        `top3Share=${audit.top3Share ?? "n/a"}%`,
      ],
      impact: "Shoppers asking AI for picks are steered to competitors.",
      affectedProviders: Object.keys(audit.providerMetrics || {}).filter(
        (id) => (audit.providerMetrics[id]?.recommendationShare ?? 100) <= DIAGNOSIS_THRESHOLDS.lowRecommendationShare
      ),
      relatedMetrics: {
        recommendationShare: rec,
        mentionShare: audit.mentionShare ?? null,
        top3Share: audit.top3Share ?? null,
      },
      severityHints: { recommendationImpact: 100 - rec, providerCoverage: 50, frequency: 70 },
    };
  },

  // Mentioned but not top-3
  (audit) => {
    const { mentionMin, top3Max } = DIAGNOSIS_THRESHOLDS.mentionWithoutTop3;
    const mention = audit.mentionShare;
    const top3 = audit.top3Share;
    if (mention == null || top3 == null) return null;
    if (mention < mentionMin || top3 > top3Max) return null;
    return {
      id: "mentioned_not_ranked",
      category: "content",
      title: "Mentioned by AI but rarely ranked in the top 3",
      description:
        "Assistants acknowledge the brand but do not elevate it. Stronger comparison and proof content can improve ranking position.",
      evidence: [
        `mentionShare=${mention}% (≥ ${mentionMin}%)`,
        `top3Share=${top3}% (≤ ${top3Max}%)`,
      ],
      impact: "Awareness without ranking still loses the sale to higher-listed brands.",
      affectedProviders: ["openai", "perplexity", "gemini"].filter(
        (id) => (audit.providerMetrics?.[id]?.mentionShare ?? 0) >= mentionMin && (audit.providerMetrics?.[id]?.top3Share ?? 100) <= top3Max
      ),
      relatedMetrics: { mentionShare: mention, top3Share: top3 },
      severityHints: { recommendationImpact: 55, frequency: 60, providerCoverage: 40 },
    };
  },

  // Competitor gap
  (audit) => {
    const gap = audit.intelligenceSummary?.competitorGap;
    if (!gap || gap.gap == null || !gap.competitorName) return null;
    if (gap.gap > DIAGNOSIS_THRESHOLDS.competitorGapHigh) return null;
    const critical = gap.gap <= DIAGNOSIS_THRESHOLDS.competitorGapCritical;
    return {
      id: `competitor_gap_${String(gap.competitorName).toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
      category: "authority",
      title: `${gap.competitorName} is recommended more often`,
      description: `Your recommendation share trails ${gap.competitorName} by ${Math.abs(gap.gap)} percentage points based on this audit's competitor snapshots.`,
      evidence: [
        `target recommendationShare=${gap.targetShare ?? audit.recommendationShare}%`,
        `competitor=${gap.competitorName} recommendationShare=${gap.competitorShare}%`,
        `gap=${gap.gap} pp`,
      ],
      impact: "AI shopping assistants preferentially surface the competitor for similar buyer questions.",
      affectedProviders: Object.keys(audit.providerMetrics || {}),
      relatedMetrics: {
        gap: gap.gap,
        competitorName: gap.competitorName,
        targetShare: gap.targetShare ?? audit.recommendationShare,
        competitorShare: gap.competitorShare,
      },
      severityHints: {
        competitorGap: Math.min(100, Math.abs(gap.gap) * 3),
        recommendationImpact: critical ? 85 : 65,
        frequency: 50,
      },
    };
  },

  // Perception missing themes
  (audit) => {
    const perception = audit.perception || audit.intelligenceSummary?.perception;
    const missing = perception?.missingThemes || [];
    if (!missing.length) return null;
    return {
      id: "perception_missing_themes",
      category: "ai_perception",
      title: "Intended positioning themes are missing from AI answers",
      description:
        "Themes present in your brand/category description do not appear in AI answer themes. Assistants may not associate you with those attributes.",
      evidence: [
        `missingThemes=${missing.join(", ")}`,
        `brandThemes=${(perception.brandThemes || []).join(", ") || "n/a"}`,
        `aiThemes=${(perception.aiThemes || []).join(", ") || "n/a"}`,
        `method=${perception.method || "unknown"}`,
      ],
      impact: "Category association gaps reduce recall when buyers ask AI using those themes.",
      affectedProviders: providersMissingBrand(audit).length
        ? providersMissingBrand(audit)
        : ["openai", "perplexity", "gemini"],
      relatedMetrics: { missingThemeCount: missing.length },
      severityHints: { recommendationImpact: 50, frequency: Math.min(100, missing.length * 25), providerCoverage: 40 },
    };
  },

  // Unexpected AI themes (optional medium)
  (audit) => {
    const perception = audit.perception || audit.intelligenceSummary?.perception;
    const unexpected = perception?.unexpectedThemes || [];
    if (!unexpected.length) return null;
    return {
      id: "perception_unexpected_themes",
      category: "ai_perception",
      title: "AI associates unexpected themes with your category answers",
      description:
        "AI answers emphasize themes not present in your stated positioning. Review whether public content is off-message or thin.",
      evidence: [
        `unexpectedThemes=${unexpected.join(", ")}`,
        `brandThemes=${(perception.brandThemes || []).join(", ") || "n/a"}`,
      ],
      impact: "Misaligned associations can dilute brand clarity in agentic recommendations.",
      affectedProviders: [],
      relatedMetrics: { unexpectedThemeCount: unexpected.length },
      severityHints: { recommendationImpact: 30, frequency: 40, providerCoverage: 20 },
    };
  },

  // Understood / entity clarity (only if evaluated)
  (audit) => {
    const und = audit.agenticScore?.understood;
    if (!und || und.status !== "ok" || und.score == null) return null;
    if (und.score >= DIAGNOSIS_THRESHOLDS.lowUnderstoodScore) return null;
    return {
      id: "weak_entity_clarity",
      category: "entity",
      title: "Product/entity clarity signals are weak",
      description:
        "The Understood dimension scored low from available on-page content signals. Agents may struggle to interpret what you sell.",
      evidence: [`understoodScore=${und.score}`, `understoodStatus=${und.status}`],
      impact: "Unclear entity understanding reduces confident recommendations.",
      affectedProviders: [],
      relatedMetrics: { understoodScore: und.score },
      severityHints: { recommendationImpact: 45, frequency: 55, providerCoverage: 20 },
    };
  },

  // Schema hint from low understood + no product themes — only when understood evaluated low
  // Actually we should only claim schema if we have schema signals. agentic understood evidence may include hasProductSchema in siteContext but that's not on audit.
  // Skip inventing schema issues unless intelligenceSummary or agentic evidence mentions it.
  (audit) => {
    const und = audit.agenticScore?.understood;
    if (!und || und.status !== "ok" || und.score == null) return null;
    if (und.score >= DIAGNOSIS_THRESHOLDS.lowUnderstoodScore) return null;
    // Only emit schema category if note/evidence from scoring mentions schema — check intelligenceSummary
    const note = und.note || "";
    if (!/schema|structured|llms/i.test(note) && und.score >= 40) return null;
    return {
      id: "incomplete_structured_signals",
      category: "schema",
      title: "Structured data / machine-readable signals appear incomplete",
      description:
        "Understood scoring from available content signals is low, which commonly reflects missing product/organization clarity for agents. Verify schema and llms.txt without assuming specific missing fields we did not scrape in this audit.",
      evidence: [
        `understoodScore=${und.score}`,
        und.note ? `note=${und.note}` : "Derived from Understood agentic dimension only",
      ],
      impact: "Agents rely on structured cues to map products and offers.",
      affectedProviders: [],
      relatedMetrics: { understoodScore: und.score },
      severityHints: { recommendationImpact: 40, frequency: 45, providerCoverage: 15 },
    };
  },

  // Commerce not evaluated / bought gap — only when we know bought is not_evaluated OR evaluated low
  (audit) => {
    const bought = audit.agenticScore?.bought;
    if (!bought) return null;
    if (bought.status === "not_evaluated") {
      return {
        id: "commerce_signals_unavailable",
        category: "commerce",
        title: "Commerce-readiness could not be evaluated",
        description:
          "This audit did not include commerce signals (offer/feed/checkout). Bought remains not_evaluated — no claim is made about checkout capability.",
        evidence: [`boughtStatus=${bought.status}`, "No Shopify/offer/checkout flags were present on this audit."],
        impact: "Without commerce signals, agentic purchase readiness stays unknown.",
        affectedProviders: [],
        relatedMetrics: { boughtStatus: bought.status },
        severityHints: { recommendationImpact: 20, frequency: 30, providerCoverage: 10 },
      };
    }
    if (bought.status === "ok" && bought.score != null && bought.score < 50) {
      return {
        id: "weak_commerce_readiness",
        category: "commerce",
        title: "Commerce-readiness signals are weak",
        description: "Evaluated commerce signals scored low. Agents may recommend you but hesitate to complete purchase flows.",
        evidence: [`boughtScore=${bought.score}`, `boughtStatus=${bought.status}`],
        impact: "Recommendation without buyability loses agent-mediated conversions.",
        affectedProviders: [],
        relatedMetrics: { boughtScore: bought.score },
        severityHints: { recommendationImpact: 50, frequency: 50, providerCoverage: 15 },
      };
    }
    return null;
  },

  // Missing comparison content — inferred only when rec low + competitor gap exists
  (audit) => {
    const rec = audit.recommendationShare;
    const gap = audit.intelligenceSummary?.competitorGap;
    if (rec == null || rec > 40) return null;
    if (!gap?.competitorName || gap.gap == null || gap.gap > -5) return null;
    return {
      id: "missing_comparison_content",
      category: "content",
      title: "Comparison content likely insufficient for AI shopping queries",
      description:
        "Low recommendation share plus a measurable competitor gap suggests buyer-comparison questions favor rivals. Dedicated comparison and FAQ content can help — only if it reflects real product differences.",
      evidence: [
        `recommendationShare=${rec}%`,
        `competitorGap vs ${gap.competitorName}=${gap.gap} pp`,
      ],
      impact: "Comparison queries are a primary AI shopping path.",
      affectedProviders: [],
      relatedMetrics: { recommendationShare: rec, gap: gap.gap, competitorName: gap.competitorName },
      severityHints: { recommendationImpact: 70, competitorGap: Math.min(100, Math.abs(gap.gap) * 2), frequency: 55 },
    };
  },

  // FAQ / buyer intent — if questions include purchase/problem categories and rec low
  (audit) => {
    const questions = audit.questions || [];
    const intentQs = questions.filter((q) => ["purchase", "problem", "comparison"].includes(q.category));
    const rec = audit.recommendationShare;
    if (!intentQs.length || rec == null || rec > DIAGNOSIS_THRESHOLDS.lowRecommendationShare) return null;
    return {
      id: "weak_buyer_intent_coverage",
      category: "content",
      title: "Buyer-intent questions are not converting into recommendations",
      description:
        "This audit asked purchase/problem/comparison questions, but recommendation share remains low. Expand FAQ and intent-matched sections using only verified product facts.",
      evidence: [
        `intentQuestions=${intentQs.length}`,
        `samples=${intentQs
          .slice(0, 3)
          .map((q) => q.question)
          .join(" | ")}`,
        `recommendationShare=${rec}%`,
      ],
      impact: "Intent-matched content is what agents quote when recommending.",
      affectedProviders: [],
      relatedMetrics: { intentQuestionCount: intentQs.length, recommendationShare: rec },
      severityHints: { recommendationImpact: 65, frequency: 50, providerCoverage: 30 },
    };
  },
];
