/**
 * AgenticASO Multi-AI Audit Engine — public server-side exports.
 */
export { detectBrand, brandVariants, mentioned, normBrand } from "./brand.js";
export { extractCompetitors, extractCompetitorNames, tryParseStructuredAppendix } from "./competitors.js";
export { normalizeProviderResult, errorResult } from "./normalize.js";
export { runProvider, runAllProviders, PROVIDERS } from "./run-provider.js";
export {
  validateStoreUrl,
  siteSignals,
  identifyBrand,
  generateBuyerQueries,
  runMultiAiAudit,
} from "./audit.js";
export { aicreditsChat, getAicreditsConfig } from "./aicredits.js";
export { buildIntelligence } from "./intelligence/index.js";
export { diagnoseAudit, generateFix } from "./diagnosis/index.js";
export {
  generateAuditFixes,
  buildAuditFixDrafts,
  persistIssueFix,
  publicFix,
  FIX_CATEGORIES,
} from "./generate-fix.js";
export { runVisibilityAuditV2, buildSiteContext, withIntelligence } from "./visibility-v2.js";
