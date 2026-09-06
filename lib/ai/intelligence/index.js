import { analyzeRecommendation, successfulProviderResults } from "./recommendation.js";
import { buildShareOfVoice } from "./share-of-voice.js";
import { computeCompetitorIntelligence, computeCompetitorGap } from "./competitors.js";
import { computePerceptionGap } from "./perception.js";
import { computeAgenticScore } from "./scoring.js";
import { POSITION_SCORE_MAP } from "./config.js";

/**
 * Build Phase 2 intelligence from a Phase 1 multi-AI audit payload.
 * Raw provider results are never mutated.
 *
 * @param {object} opts
 * @param {string} opts.brandName
 * @param {Array<{ query: string, providers: import("../types.js").AIProviderResult[] }>} opts.byQuestion
 * @param {string} [opts.category]
 * @param {string} [opts.whatTheySell]
 * @param {string} [opts.brandDescription]
 * @param {object} [opts.siteContext] discoverability / content / commerce signals
 * @param {string[]} [opts.buyerQuestions]
 */
export function buildIntelligence({
  brandName,
  byQuestion = [],
  category = "",
  whatTheySell = "",
  brandDescription = "",
  siteContext = {},
  buyerQuestions = [],
} = {}) {
  const questions = (byQuestion || []).map((r) => r.query).filter(Boolean);
  const qs = buyerQuestions.length ? buyerQuestions : questions;

  const shareOfVoice = buildShareOfVoice(byQuestion);
  const competitors = computeCompetitorIntelligence(byQuestion, brandName);
  const competitorGap = computeCompetitorGap(shareOfVoice.overall, competitors);
  const perception = computePerceptionGap({
    brandDescription: brandDescription || whatTheySell,
    category,
    whatTheySell,
    buyerQuestions: qs,
    byQuestion,
  });
  const agenticScore = computeAgenticScore({
    siteContext,
    shareOfVoiceOverall: shareOfVoice.overall,
  });

  const analyses = successfulProviderResults(byQuestion).map((r) => ({
    provider: r.provider,
    question: r.question,
    analysis: analyzeRecommendation(r),
  }));

  return {
    overall: {
      brand: brandName,
      category,
      successfulTests: shareOfVoice.overall.totalTests,
      mentionShare: shareOfVoice.overall.mentionShare,
      recommendationShare: shareOfVoice.overall.recommendationShare,
      top3Share: shareOfVoice.overall.top3Share,
    },
    shareOfVoice: shareOfVoice.overall,
    providers: shareOfVoice.providers,
    competitors: {
      list: competitors,
      gap: competitorGap,
    },
    perception,
    agenticScore,
    recommendationAnalyses: analyses,
    config: {
      positionScoreMap: POSITION_SCORE_MAP,
    },
  };
}

export { analyzeRecommendation, successfulProviderResults, allProviderResults } from "./recommendation.js";
export { buildShareOfVoice, computeShareOfVoice, computeProviderShareOfVoice, percent } from "./share-of-voice.js";
export { computeCompetitorIntelligence, computeCompetitorGap } from "./competitors.js";
export { computePerceptionGap, deterministicThemeExtractor } from "./perception.js";
export {
  computeAgenticScore,
  scoreFound,
  scoreUnderstood,
  scoreRecommended,
  scoreBought,
  notEvaluated,
} from "./scoring.js";
export { positionScore, POSITION_SCORE_MAP, AGENTIC_SCORE_WEIGHTS, PROVIDER_IDS } from "./config.js";
