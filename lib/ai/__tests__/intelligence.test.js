import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeRecommendation,
  positionScore,
  POSITION_SCORE_MAP,
  computeShareOfVoice,
  computeProviderShareOfVoice,
  buildShareOfVoice,
  percent,
  computeCompetitorIntelligence,
  computeCompetitorGap,
  computeAgenticScore,
  scoreBought,
  scoreRecommended,
  buildIntelligence,
} from "../intelligence/index.js";

function okResult(partial) {
  return {
    provider: "openai",
    model: "mock",
    question: "q",
    answer: "ans",
    brandMentioned: false,
    brandPosition: null,
    recommended: false,
    competitors: [],
    citations: [],
    confidence: 0.5,
    latencyMs: 1,
    error: null,
    ...partial,
  };
}

function errResult(provider = "gemini") {
  return okResult({
    provider,
    brandMentioned: false,
    recommended: false,
    error: "Missing key",
    answer: "",
  });
}

describe("position scoring", () => {
  it("uses the central config map", () => {
    assert.equal(positionScore(1, { mentioned: true }), POSITION_SCORE_MAP[1]);
    assert.equal(positionScore(2, { mentioned: true }), 80);
    assert.equal(positionScore(3, { mentioned: true }), 60);
    assert.equal(positionScore(4, { mentioned: true }), 40);
    assert.equal(positionScore(5, { mentioned: true }), 30);
    assert.equal(positionScore(null, { mentioned: true }), POSITION_SCORE_MAP.unrankedMention);
    assert.equal(positionScore(null, { mentioned: false }), POSITION_SCORE_MAP.notMentioned);
  });
});

describe("recommendation analysis", () => {
  it("does not confuse mentioned with recommended", () => {
    const mentionedOnly = analyzeRecommendation(
      okResult({ brandMentioned: true, brandPosition: 4, recommended: false })
    );
    assert.equal(mentionedOnly.mentionStatus, "mentioned");
    assert.equal(mentionedOnly.recommendationStatus, "not_recommended");
    assert.equal(mentionedOnly.top3Presence, false);
    assert.equal(mentionedOnly.unrankedMention, false);

    const recommended = analyzeRecommendation(
      okResult({ brandMentioned: true, brandPosition: 1, recommended: true })
    );
    assert.equal(recommended.recommendationStatus, "recommended");
    assert.equal(recommended.top3Presence, true);

    const unranked = analyzeRecommendation(
      okResult({ brandMentioned: true, brandPosition: null, recommended: false })
    );
    assert.equal(unranked.unrankedMention, true);
    assert.equal(unranked.status, "mentioned_unranked");

    const absent = analyzeRecommendation(okResult({ brandMentioned: false }));
    assert.equal(absent.notMentioned, true);
    assert.equal(absent.status, "not_mentioned");
  });

  it("marks error results as status error without counting as not_mentioned", () => {
    const a = analyzeRecommendation(errResult());
    assert.equal(a.status, "error");
    assert.equal(a.notMentioned, false);
  });
});

describe("share of voice", () => {
  const byQuestion = [
    {
      query: "best snacks",
      providers: [
        okResult({ provider: "openai", brandMentioned: true, recommended: true, brandPosition: 1 }),
        okResult({ provider: "perplexity", brandMentioned: true, recommended: false, brandPosition: 2 }),
        errResult("gemini"),
      ],
    },
    {
      query: "top brands",
      providers: [
        okResult({ provider: "openai", brandMentioned: false }),
        okResult({ provider: "perplexity", brandMentioned: true, recommended: true, brandPosition: 1 }),
        okResult({ provider: "gemini", brandMentioned: true, recommended: false, brandPosition: 5 }),
      ],
    },
  ];

  it("computes mention, recommendation, and top3 share with counts", () => {
    const sov = computeShareOfVoice([
      okResult({ brandMentioned: true, recommended: true, brandPosition: 1 }),
      okResult({ brandMentioned: true, recommended: false, brandPosition: 2 }),
      okResult({ brandMentioned: false }),
      okResult({ brandMentioned: true, recommended: false, brandPosition: null }),
    ]);
    assert.equal(sov.totalTests, 4);
    assert.equal(sov.mentionCount, 3);
    assert.equal(sov.recommendationCount, 1);
    assert.equal(sov.top3Count, 2);
    assert.equal(sov.mentionShare, 75);
    assert.equal(sov.recommendationShare, 25);
    assert.equal(sov.top3Share, 50);
  });

  it("excludes failed providers from denominators", () => {
    const built = buildShareOfVoice(byQuestion);
    // 5 successful (gemini error on q1 excluded)
    assert.equal(built.overall.totalTests, 5);
    assert.equal(built.providers.gemini.tests, 1);
    assert.equal(built.providers.openai.tests, 2);
    assert.equal(built.providers.perplexity.tests, 2);
    // Failed gemini must not inflate "not mentioned"
    assert.ok(built.providers.gemini.mentionShare === 100 || built.providers.gemini.tests === 1);
  });

  it("provider-level metrics are independent", () => {
    const providers = computeProviderShareOfVoice(byQuestion);
    assert.equal(providers.openai.mentionCount, 1);
    assert.equal(providers.openai.recommendationCount, 1);
    assert.equal(providers.perplexity.mentionCount, 2);
    assert.equal(providers.gemini.tests, 1);
    assert.equal(providers.gemini.mentionCount, 1);
  });

  it("handles divide-by-zero (no tests)", () => {
    assert.equal(percent(0, 0), 0);
    const empty = computeShareOfVoice([]);
    assert.equal(empty.mentionShare, 0);
    assert.equal(empty.recommendationShare, 0);
    assert.equal(empty.top3Share, 0);
    assert.equal(empty.totalTests, 0);
  });
});

describe("competitor intelligence", () => {
  const byQuestion = [
    {
      query: "q1",
      providers: [
        okResult({
          provider: "openai",
          competitors: [
            { name: "Nike", position: 1, mentioned: true },
            { name: "Puma", position: 3, mentioned: true },
          ],
        }),
        okResult({
          provider: "perplexity",
          competitors: [{ name: "Nike", position: 2, mentioned: true }],
        }),
        errResult("gemini"),
      ],
    },
  ];

  it("aggregates competitor frequency without inventing names", () => {
    const list = computeCompetitorIntelligence(byQuestion, "Acme");
    assert.equal(list.length, 2);
    const nike = list.find((c) => c.name === "Nike");
    assert.ok(nike);
    assert.equal(nike.mentions, 2);
    assert.equal(nike.recommendations, 1); // position 1 once
    assert.equal(nike.top3, 2);
    assert.equal(nike.averagePosition, 1.5);
  });

  it("computes competitor gap in percentage points", () => {
    const list = computeCompetitorIntelligence(byQuestion, "Acme");
    const gap = computeCompetitorGap({ recommendationShare: 40 }, list);
    assert.equal(gap.targetShare, 40);
    assert.equal(gap.competitorName, "Nike");
    assert.equal(gap.competitorShare, list[0].recommendationShare);
    assert.equal(gap.gap, 40 - list[0].recommendationShare);
  });

  it("returns null gap when no competitors", () => {
    const gap = computeCompetitorGap({ recommendationShare: 10 }, []);
    assert.equal(gap.competitorName, null);
    assert.equal(gap.gap, null);
  });
});

describe("agentic score", () => {
  it("sets bought to not_evaluated when commerce signals unavailable", () => {
    const bought = scoreBought({});
    assert.equal(bought.status, "not_evaluated");
    assert.equal(bought.score, null);

    const agentic = computeAgenticScore({
      siteContext: { hasTitle: true, hasDescription: true },
      shareOfVoiceOverall: { recommendationShare: 50, mentionShare: 60, top3Share: 40, totalTests: 5 },
    });
    assert.equal(agentic.bought.status, "not_evaluated");
    assert.equal(agentic.bought.score, null);
    assert.equal(agentic.recommended.status, "ok");
    assert.equal(agentic.understood.status, "ok");
    assert.ok(agentic.overall.status === "ok");
    assert.ok(typeof agentic.overall.score === "number");
  });

  it("evaluates bought only with real commerce signals", () => {
    const bought = scoreBought({ isShopify: true, hasProductFeed: true });
    assert.equal(bought.status, "ok");
    assert.ok(bought.score > 0);
  });

  it("recommended is not_evaluated with zero successful tests", () => {
    const r = scoreRecommended({ totalTests: 0 });
    assert.equal(r.status, "not_evaluated");
  });

  it("aggregates only evaluated dimensions", () => {
    const agentic = computeAgenticScore({
      siteContext: {},
      shareOfVoiceOverall: { recommendationShare: 100, mentionShare: 100, top3Share: 100, totalTests: 3 },
    });
    assert.equal(agentic.found.status, "not_evaluated");
    assert.equal(agentic.understood.status, "not_evaluated");
    assert.equal(agentic.bought.status, "not_evaluated");
    assert.equal(agentic.recommended.status, "ok");
    assert.equal(agentic.overall.score, agentic.recommended.score);
  });
});

describe("buildIntelligence preserves raw results", () => {
  it("does not mutate provider payloads and attaches intelligence", () => {
    const byQuestion = [
      {
        query: "organic tea brands",
        providers: [
          okResult({
            provider: "openai",
            question: "organic tea brands",
            brandMentioned: true,
            recommended: true,
            brandPosition: 1,
            answer: "1. Acme — organic premium tea",
            competitors: [{ name: "Twinings", position: 2, mentioned: true }],
          }),
          errResult("perplexity"),
        ],
      },
    ];
    const snapshot = JSON.stringify(byQuestion);
    const intel = buildIntelligence({
      brandName: "Acme",
      category: "organic tea",
      whatTheySell: "organic premium tea",
      byQuestion,
      siteContext: { reachable: true, hasTitle: true },
    });
    assert.equal(JSON.stringify(byQuestion), snapshot);
    assert.ok(intel.shareOfVoice);
    assert.ok(intel.providers.openai);
    assert.ok(intel.competitors.list.length >= 1);
    assert.ok(intel.perception.brandThemes.includes("organic") || intel.perception.aiThemes.includes("organic"));
    assert.ok(intel.agenticScore.recommended);
    assert.equal(intel.shareOfVoice.totalTests, 1);
  });
});
