import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectBrand, brandVariants, normBrand } from "../brand.js";
import { extractCompetitors, tryParseStructuredAppendix } from "../competitors.js";
import { normalizeProviderResult, errorResult } from "../normalize.js";
import { runAllProviders, runProvider } from "../run-provider.js";

describe("brand detection", () => {
  it("detects exact brand mention", () => {
    const r = detectBrand("I recommend Acme Foods for snacks.", "Acme Foods", "https://acmefoods.com");
    assert.equal(r.mentioned, true);
    assert.equal(r.status === "recommended" || r.status === "mentioned" || r.status === "ranked", true);
  });

  it("detects domain stem variant", () => {
    const r = detectBrand("Try shopping at brightbite.com for healthy bars.", "BrightBite", "https://www.brightbite.com");
    assert.equal(r.mentioned, true);
  });

  it("returns not_mentioned when absent", () => {
    const r = detectBrand("Nike and Adidas dominate this list.", "BrightBite", "https://brightbite.com");
    assert.equal(r.mentioned, false);
    assert.equal(r.status, "not_mentioned");
    assert.equal(r.position, null);
  });

  it("avoids short mid-word false positives", () => {
    const r = detectBrand("This is a smart choice overall.", "Art", "https://art.example");
    // "art" inside "smart" should not match for short stems
    assert.equal(r.mentioned, false);
  });

  it("reads numbered position", () => {
    const r = detectBrand("1. Nike\n2. Acme Foods\n3. Puma", "Acme Foods", "https://acmefoods.com");
    assert.equal(r.mentioned, true);
    assert.equal(r.position, 2);
  });

  it("builds conservative variants", () => {
    const v = brandVariants("Acme Foods", "https://www.acmefoods.com");
    assert.ok(v.includes("acme foods") || v.some((x) => x.includes("acme")));
    assert.ok(v.every((x) => x.length >= 3));
  });

  it("normBrand strips tld noise", () => {
    assert.equal(normBrand("www.AcmeFoods.com"), "acmefoods");
  });
});

describe("competitor extraction", () => {
  it("parses structured appendix", () => {
    const answer = `Here are options.\n{"brands":[{"name":"Nike","position":1,"recommended":true},{"name":"Acme","position":2}],"citations":["https://ex.com"]}`;
    const parsed = tryParseStructuredAppendix(answer);
    assert.ok(parsed);
    assert.equal(parsed.brands.length, 2);
    const comps = extractCompetitors(answer, "Other");
    assert.equal(comps[0].name, "Nike");
    assert.equal(comps[0].position, 1);
  });

  it("extracts numbered list competitors and excludes target brand", () => {
    const answer = "1. Nike\n2. Acme Foods\n3. Puma\n4. Adidas";
    const comps = extractCompetitors(answer, "Acme Foods");
    assert.ok(comps.every((c) => c.name !== "Acme Foods"));
    assert.ok(comps.some((c) => c.name === "Nike"));
    assert.ok(comps[0].mentioned === true);
  });

  it("is deterministic for same input", () => {
    const answer = "1. BrandA\n2. BrandB\n3. BrandC";
    const a = extractCompetitors(answer, "Target");
    const b = extractCompetitors(answer, "Target");
    assert.deepEqual(a, b);
  });
});

describe("provider normalization", () => {
  it("normalizes a successful answer", () => {
    const result = normalizeProviderResult({
      provider: "openai",
      model: "openai/gpt-4o-mini",
      question: "best running shoes",
      answer: "1. Nike\n2. Acme\n{\"brands\":[{\"name\":\"Nike\",\"position\":1},{\"name\":\"Acme\",\"position\":2}],\"citations\":[]}",
      brandName: "Acme",
      websiteUrl: "https://acme.com",
      latencyMs: 1200,
    });
    assert.equal(result.provider, "openai");
    assert.equal(result.brandMentioned, true);
    assert.equal(result.error, null);
    assert.ok(Array.isArray(result.competitors));
    assert.ok(result.confidence > 0);
    assert.equal(result.latencyMs, 1200);
  });

  it("builds error results", () => {
    const r = errorResult("gemini", "gemini-2.0-flash", "q", "Missing GEMINI_API_KEY", 5);
    assert.equal(r.provider, "gemini");
    assert.equal(r.brandMentioned, false);
    assert.equal(r.error, "Missing GEMINI_API_KEY");
    assert.equal(r.answer, "");
  });
});

describe("multi-provider execution (mocked)", () => {
  it("returns independent results when providers are mocked", async () => {
    const { PROVIDERS } = await import("../run-provider.js");
    const original = {
      openai: PROVIDERS.openai.runBuyerQuery,
      perplexity: PROVIDERS.perplexity.runBuyerQuery,
      gemini: PROVIDERS.gemini.runBuyerQuery,
    };

    PROVIDERS.openai.runBuyerQuery = async (input) =>
      normalizeProviderResult({
        provider: "openai",
        model: "mock-openai",
        question: input.buyerQuestion,
        answer: "1. MockBrand\n2. Other",
        brandName: input.brandName,
        websiteUrl: input.websiteUrl,
        latencyMs: 1,
      });
    PROVIDERS.perplexity.runBuyerQuery = async (input) =>
      normalizeProviderResult({
        provider: "perplexity",
        model: "mock-pplx",
        question: input.buyerQuestion,
        answer: "I recommend Other only.",
        brandName: input.brandName,
        websiteUrl: input.websiteUrl,
        latencyMs: 2,
      });
    PROVIDERS.gemini.runBuyerQuery = async (input) =>
      normalizeProviderResult({
        provider: "gemini",
        model: "mock-gemini",
        question: input.buyerQuestion,
        answer: "1. MockBrand is best.",
        brandName: input.brandName,
        websiteUrl: input.websiteUrl,
        latencyMs: 3,
      });

    try {
      const results = await runAllProviders({
        brandName: "MockBrand",
        websiteUrl: "https://mockbrand.com",
        buyerQuestion: "best snacks",
      });
      assert.equal(results.length, 3);
      assert.deepEqual(
        results.map((r) => r.provider).sort(),
        ["gemini", "openai", "perplexity"]
      );
      assert.ok(results.every((r) => r.error === null));
      const byId = Object.fromEntries(results.map((r) => [r.provider, r]));
      assert.equal(byId.openai.brandMentioned, true);
      assert.equal(byId.perplexity.brandMentioned, false);
      assert.equal(byId.gemini.brandMentioned, true);
    } finally {
      PROVIDERS.openai.runBuyerQuery = original.openai;
      PROVIDERS.perplexity.runBuyerQuery = original.perplexity;
      PROVIDERS.gemini.runBuyerQuery = original.gemini;
    }
  });

  it("keeps other providers when one fails", async () => {
    const { PROVIDERS } = await import("../run-provider.js");
    const original = {
      openai: PROVIDERS.openai.runBuyerQuery,
      perplexity: PROVIDERS.perplexity.runBuyerQuery,
      gemini: PROVIDERS.gemini.runBuyerQuery,
    };

    PROVIDERS.openai.runBuyerQuery = async () => {
      throw new Error("boom");
    };
    PROVIDERS.perplexity.runBuyerQuery = async (input) =>
      normalizeProviderResult({
        provider: "perplexity",
        model: "mock",
        question: input.buyerQuestion,
        answer: "ok",
        brandName: input.brandName,
        latencyMs: 1,
      });
    PROVIDERS.gemini.runBuyerQuery = async (input) =>
      normalizeProviderResult({
        provider: "gemini",
        model: "mock",
        question: input.buyerQuestion,
        answer: "ok",
        brandName: input.brandName,
        latencyMs: 1,
      });

    try {
      const results = await runAllProviders({
        brandName: "X",
        websiteUrl: "https://x.com",
        buyerQuestion: "q",
      });
      assert.equal(results.length, 3);
      const failed = results.find((r) => r.provider === "openai");
      assert.ok(failed.error);
      assert.ok(results.filter((r) => r.provider !== "openai").every((r) => r.error === null));
    } finally {
      PROVIDERS.openai.runBuyerQuery = original.openai;
      PROVIDERS.perplexity.runBuyerQuery = original.perplexity;
      PROVIDERS.gemini.runBuyerQuery = original.gemini;
    }
  });

  it("returns error result when Gemini API key is missing (no live call)", async () => {
    const prev = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const r = await runProvider("gemini", {
        brandName: "Acme",
        websiteUrl: "https://acme.com",
        buyerQuestion: "best acme alternatives",
      });
      assert.equal(r.provider, "gemini");
      assert.ok(r.error);
      assert.match(r.error, /GEMINI_API_KEY/);
      assert.equal(r.brandMentioned, false);
    } finally {
      if (prev === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prev;
    }
  });

  it("returns error result when AICREDITS keys missing for openai (no live call)", async () => {
    const prevBase = process.env.AICREDITS_BASE_URL;
    const prevKey = process.env.AICREDITS_API_KEY;
    delete process.env.AICREDITS_BASE_URL;
    delete process.env.AICREDITS_API_KEY;
    try {
      const r = await runProvider("openai", {
        brandName: "Acme",
        websiteUrl: "https://acme.com",
        buyerQuestion: "best snacks",
      });
      assert.equal(r.provider, "openai");
      assert.ok(r.error);
      assert.match(r.error, /AICREDITS/);
    } finally {
      if (prevBase === undefined) delete process.env.AICREDITS_BASE_URL;
      else process.env.AICREDITS_BASE_URL = prevBase;
      if (prevKey === undefined) delete process.env.AICREDITS_API_KEY;
      else process.env.AICREDITS_API_KEY = prevKey;
    }
  });
});
