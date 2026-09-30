import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildReasonerMessages,
  qualifyProspect,
  GROWTH_REASONING_MODEL,
  GROWTH_REASONING_TEMPERATURE,
  GROWTH_REASONING_MAX_ATTEMPTS,
  parseModelJson,
} from "../qualification-reasoner.js";
import { EVAL_CASES, SAMPLE_PRODUCT_PROFILE } from "../eval/fixtures.js";

function chatSequence(replies) {
  const calls = [];
  const fn = async (model, messages, opts) => {
    calls.push({ model, messages, opts });
    const next = replies[calls.length - 1];
    if (typeof next === "function") return next(model, messages, opts);
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

describe("qualification reasoner", () => {
  it("keeps product context and evidence pack separated and omits raw HTML", () => {
    const pack = EVAL_CASES[0].pack;
    const messages = buildReasonerMessages(pack, SAMPLE_PRODUCT_PROFILE);
    assert.equal(messages[0].role, "system");
    assert.match(messages[0].content, /NOT evidence about the prospect/i);
    assert.match(messages[0].content, /untrusted quoted webpage data/i);
    assert.match(messages[1].content, /A\. PRODUCT \/ ICP CONTEXT/);
    assert.match(messages[1].content, /B\. PROSPECT EVIDENCE/);
    assert.match(messages[1].content, /C\. OBSERVED CONTACTS \(NOT fit evidence/);
    assert.match(messages[1].content, /EV-001/);
    assert.equal(messages[1].content.includes("<html"), false);
    assert.equal(JSON.stringify(messages).includes("runAllProviders"), false);
  });

  it("short-circuits Shopify vs WooCommerce target with zero LLM calls", async () => {
    const shopify = EVAL_CASES.find((c) => c.id === "shopify_vs_woocommerce_target");
    const chat = chatSequence(["should not run"]);
    const result = await qualifyProspect({
      pack: shopify.pack,
      productProfile: shopify.productProfile,
      chatFn: chat,
    });
    assert.equal(result.ok, true);
    assert.equal(result.shortCircuited, true);
    assert.equal(result.qualification.decision, "not_fit");
    assert.equal(result.usage.llmCalls, 0);
    assert.equal(chat.calls.length, 0);
  });

  it("parses JSON, runs the structural validator, and records low-variance model config", async () => {
    const pack = EVAL_CASES[0].pack;
    const id = pack.evidence[0].id;
    const chat = chatSequence([
      JSON.stringify({
        decision: "possible_fit",
        summary: "WooCommerce and subscription evidence align with the ICP.",
        reasons: [
          {
            type: "observation",
            statement: "WooCommerce plugin assets were observed.",
            evidenceIds: [id],
          },
        ],
        uncertainties: [],
      }),
    ]);
    const result = await qualifyProspect({
      pack,
      productProfile: SAMPLE_PRODUCT_PROFILE,
      chatFn: chat,
    });
    assert.equal(result.ok, true);
    assert.equal(chat.calls[0].model, GROWTH_REASONING_MODEL);
    assert.equal(chat.calls[0].opts.temperature, GROWTH_REASONING_TEMPERATURE);
    assert.equal(result.qualification.decision, "possible_fit");
  });

  it("retries invalid JSON once then fails without inventing a qualification", async () => {
    const pack = EVAL_CASES[0].pack;
    const chat = chatSequence(["not json", "still not json"]);
    const result = await qualifyProspect({
      pack,
      productProfile: SAMPLE_PRODUCT_PROFILE,
      chatFn: chat,
    });
    assert.equal(result.ok, false);
    assert.equal(result.qualification, null);
    assert.equal(chat.calls.length, GROWTH_REASONING_MAX_ATTEMPTS);
    assert.equal(parseModelJson("not json").ok, false);
  });

  it("retries schema-invalid JSON once and accepts a valid second attempt", async () => {
    const pack = EVAL_CASES[0].pack;
    const id = pack.evidence[0].id;
    const chat = chatSequence([
      JSON.stringify({ decision: "perfect", summary: "nope" }),
      JSON.stringify({
        decision: "insufficient_evidence",
        summary: "Need more storefront evidence.",
        reasons: [
          {
            type: "observation",
            statement: "WooCommerce plugin assets were observed, but other ICP signals are thin.",
            evidenceIds: [id],
          },
        ],
      }),
    ]);
    const result = await qualifyProspect({
      pack,
      productProfile: SAMPLE_PRODUCT_PROFILE,
      chatFn: chat,
    });
    assert.equal(result.ok, true);
    assert.equal(result.qualification.decision, "insufficient_evidence");
    assert.equal(chat.calls.length, 2);
  });

  it("returns a structured failure when the adapter throws", async () => {
    const pack = EVAL_CASES[1].pack;
    const result = await qualifyProspect({
      pack,
      productProfile: SAMPLE_PRODUCT_PROFILE,
      chatFn: chatSequence([new Error("timeout")]),
    });
    assert.equal(result.ok, false);
    assert.equal(result.qualification, null);
    assert.match(result.error, /timeout/);
  });

  it("accepts extra model keys after coerce without a second call", async () => {
    const pack = EVAL_CASES[0].pack;
    const id = pack.evidence[0].id;
    const chat = chatSequence([
      JSON.stringify({
        decision: "possible_fit",
        summary: "WooCommerce plugin assets were observed.",
        confidence: 0.8,
        reasons: [
          {
            type: "observation",
            text: "WooCommerce plugin assets were observed.",
            evidenceIds: [id],
            weight: 2,
          },
        ],
        uncertainties: ["Payment mix beyond the cited methods is unknown."],
      }),
    ]);
    const result = await qualifyProspect({
      pack,
      productProfile: SAMPLE_PRODUCT_PROFILE,
      chatFn: chat,
    });
    assert.equal(result.ok, true);
    assert.equal(chat.calls.length, 1);
    assert.equal(result.qualification.decision, "possible_fit");
    assert.equal(result.qualification.reasons[0].statement.includes("WooCommerce"), true);
    assert.equal(result.usage.contract.firstRawOk, false);
    assert.equal(result.usage.contract.firstNormalizedOk, true);
    assert.equal(result.usage.contract.retryUsed, false);
  });

  it("does not treat inconclusive platform packs as verified WooCommerce in the prompt", () => {
    const pack = EVAL_CASES.find((c) => c.id === "platform_inconclusive").pack;
    const messages = buildReasonerMessages(pack, SAMPLE_PRODUCT_PROFILE);
    assert.match(JSON.stringify(messages), /inconclusive/);
    assert.equal(pack.platform.status, "inconclusive");
  });

  it("forwards optional response_format and still rejects unknown evidence ids locally", async () => {
    const pack = EVAL_CASES[0].pack;
    const chat = chatSequence([
      JSON.stringify({
        decision: "possible_fit",
        summary: "Cited a fake id.",
        reasons: [
          {
            type: "observation",
            statement: "WooCommerce plugin assets were observed.",
            evidenceIds: ["EV-999"],
          },
        ],
        uncertainties: [],
      }),
      JSON.stringify({
        decision: "possible_fit",
        summary: "Cited a fake id.",
        reasons: [
          {
            type: "observation",
            statement: "WooCommerce plugin assets were observed.",
            evidenceIds: ["EV-999"],
          },
        ],
        uncertainties: [],
      }),
    ]);
    const result = await qualifyProspect({
      pack,
      productProfile: SAMPLE_PRODUCT_PROFILE,
      chatFn: chat,
    });
    assert.equal(chat.calls[0].opts.response_format.type, "json_schema");
    assert.equal(result.ok, false);
  });
});
