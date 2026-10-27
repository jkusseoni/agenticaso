import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  diagnoseAudit,
  generateFix,
  sanitizeSuggestedContent,
  assertSafeSuggestion,
  severityScore,
  priorityFromScore,
  providersMissingBrand,
  DIAGNOSIS_THRESHOLDS,
} from "../index.js";
import { compareAudits } from "../../../db/compare.js";

const baseAudit = {
  id: "audit_1",
  websiteId: "w1",
  website: { domain: "acmefoods.com", brandName: "Acme Foods", category: "organic snacks", url: "https://acmefoods.com" },
  mentionShare: 10,
  recommendationShare: 5,
  top3Share: 0,
  providerMetrics: {
    openai: { mentionShare: 0, recommendationShare: 0, top3Share: 0, tests: 2 },
    perplexity: { mentionShare: 0, recommendationShare: 0, top3Share: 0, tests: 2 },
    gemini: { mentionShare: 0, recommendationShare: 0, top3Share: 0, tests: 2 },
  },
  aiTests: [
    { provider: "openai", brandMentioned: false, error: null },
    { provider: "openai", brandMentioned: false, error: null },
    { provider: "perplexity", brandMentioned: false, error: null },
    { provider: "gemini", brandMentioned: false, error: null },
  ],
  agenticScore: {
    found: { score: null, status: "not_evaluated" },
    understood: { score: 40, status: "ok", note: "No product schema or llms.txt found" },
    recommended: { score: 10, status: "ok" },
    bought: { score: null, status: "not_evaluated" },
    overall: { score: 25, status: "ok" },
  },
  competitors: [{ name: "Kind", recommendationShare: 60, top3Share: 50, mentions: 5 }],
  intelligenceSummary: {
    competitorGap: { targetShare: 5, competitorShare: 60, gap: -55, competitorName: "Kind" },
    perception: {
      brandThemes: ["organic"],
      aiThemes: ["protein"],
      missingThemes: ["organic"],
      unexpectedThemes: ["protein"],
      method: "deterministic_keywords",
    },
  },
  perception: {
    brandThemes: ["organic"],
    aiThemes: ["protein"],
    missingThemes: ["organic"],
    unexpectedThemes: ["protein"],
    method: "deterministic_keywords",
  },
  questions: [
    { id: "q1", question: "best organic snacks", category: "discovery" },
    { id: "q2", question: "where to buy protein bars", category: "purchase" },
    { id: "q3", question: "Kind vs alternatives", category: "comparison" },
  ],
};

describe("diagnosis rules + evidence", () => {
  it("flags cross-provider invisibility with evidence", () => {
    const missing = providersMissingBrand(baseAudit);
    assert.ok(missing.length >= DIAGNOSIS_THRESHOLDS.crossProviderMissMin);
    const { issues } = diagnoseAudit(baseAudit);
    const cross = issues.find((i) => i.id === "cross_ai_invisibility");
    assert.ok(cross);
    assert.ok(cross.evidence.some((e) => /Providers with no brand mention/i.test(e)));
    assert.ok(cross.affectedProviders.includes("openai"));
  });

  it("does not treat failed providers as not mentioned", () => {
    const audit = {
      ...baseAudit,
      providerMetrics: {
        openai: { mentionShare: 100, recommendationShare: 50, top3Share: 50, tests: 1 },
        perplexity: { mentionShare: 0, recommendationShare: 0, top3Share: 0, tests: 0 },
        gemini: { mentionShare: 0, recommendationShare: 0, top3Share: 0, tests: 0 },
      },
      aiTests: [
        { provider: "openai", brandMentioned: true, error: null },
        { provider: "gemini", brandMentioned: false, error: "Missing GEMINI_API_KEY" },
      ],
    };
    const missing = providersMissingBrand(audit);
    assert.ok(!missing.includes("gemini"));
  });

  it("creates competitor-gap and perception-gap issues", () => {
    const { issues, summary } = diagnoseAudit(baseAudit);
    assert.ok(issues.some((i) => i.id.startsWith("competitor_gap_")));
    assert.ok(issues.some((i) => i.id === "perception_missing_themes"));
    assert.ok(summary.critical + summary.high + summary.medium + summary.low === issues.length);
  });

  it("assigns configurable priorities", () => {
    assert.equal(priorityFromScore(85), "critical");
    assert.equal(priorityFromScore(65), "high");
    assert.equal(priorityFromScore(40), "medium");
    assert.equal(priorityFromScore(10), "low");
    assert.ok(severityScore({ recommendationImpact: 100, providerCoverage: 100, competitorGap: 100, frequency: 100 }) >= 90);
  });
});

describe("fix engine", () => {
  it("generates actionable fix with review banner", () => {
    const { issues } = diagnoseAudit(baseAudit);
    const issue = issues.find((i) => i.id === "cross_ai_invisibility");
    const fix = generateFix(issue, baseAudit);
    assert.equal(fix.issueId, issue.id);
    assert.match(fix.disclaimer, /review before publishing/i);
    assert.ok(fix.implementationSteps.length >= 3);
    assert.ok(fix.suggestedContent.body.includes("Suggested"));
    assert.ok(fix.verificationPlan.some((s) => /re-audit|Re-audit|re-run/i.test(s)));
  });

  it("sanitizes hallucinated claim patterns", () => {
    const cleaned = sanitizeSuggestedContent("We have 5000 customers and are award winning with 99% satisfaction");
    assert.ok(!/5000 customers/i.test(cleaned) || /verify/i.test(cleaned));
    assert.ok(/verify before publishing|remove unverified/i.test(cleaned));
    const fix = generateFix(
      { id: "low_recommendation_share", title: "t", description: "d", evidence: ["e"] },
      baseAudit
    );
    assert.equal(assertSafeSuggestion(fix), true);
  });

  it("maps competitor gap issue to comparison fix", () => {
    const { issues } = diagnoseAudit(baseAudit);
    const gapIssue = issues.find((i) => i.id.startsWith("competitor_gap_"));
    const fix = generateFix(gapIssue, baseAudit);
    assert.match(fix.title, /comparison/i);
    assert.ok(fix.suggestedContent.body.includes("Acme Foods") || fix.why.includes("Kind"));
  });
});

describe("re-audit comparison wording support", () => {
  it("computes before/after deltas without claiming causation", () => {
    const comparison = compareAudits(
      {
        id: "after",
        websiteId: "w1",
        status: "completed",
        mentionShare: 57,
        recommendationShare: 40,
        top3Share: 30,
        overallScore: 60,
        providerMetrics: {
          openai: { recommendationShare: 50 },
          perplexity: { recommendationShare: 45 },
          gemini: { recommendationShare: 35 },
        },
        competitors: [],
      },
      {
        id: "before",
        websiteId: "w1",
        status: "completed",
        mentionShare: 42,
        recommendationShare: 25,
        top3Share: 20,
        overallScore: 40,
        providerMetrics: {
          openai: { recommendationShare: 32 },
          perplexity: { recommendationShare: 38 },
          gemini: { recommendationShare: 24 },
        },
        competitors: [],
      }
    );
    assert.equal(comparison.missingPrevious, false);
    assert.equal(comparison.delta.share.mentionShare.delta, 15);
    assert.equal(comparison.delta.providers.openai.delta, 18);
    assert.equal(comparison.delta.providers.perplexity.delta, 7);
    assert.equal(comparison.delta.providers.gemini.delta, 11);
  });
});

describe("ownership-shaped diagnose empty input", () => {
  it("returns empty diagnosis for null audit", () => {
    const d = diagnoseAudit(null);
    assert.equal(d.issues.length, 0);
    assert.equal(d.summary.critical, 0);
  });
});
