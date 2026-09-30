import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildQualificationContext, formatQualificationUserContent, packHasRawHtml } from "../qualification-context.js";
import { EVAL_CASES, SAMPLE_PRODUCT_PROFILE } from "../eval/fixtures.js";
import { normalizeProductProfile } from "../qualification-contract.js";

describe("qualification context", () => {
  it("exposes every evidence id, omits raw HTML, and keeps product context separate", () => {
    const pack = EVAL_CASES[0].pack;
    const ctx = buildQualificationContext(pack);
    for (const row of pack.evidence) {
      assert.ok(ctx.evidenceIds.includes(row.id));
      assert.match(ctx.renderedEvidence, new RegExp(row.id));
    }
    const profile = JSON.stringify(normalizeProductProfile(SAMPLE_PRODUCT_PROFILE));
    const text = formatQualificationUserContent(pack, profile);
    assert.equal(packHasRawHtml(text), false);
    assert.equal(text.includes("<html"), false);
    assert.match(text, /A\. PRODUCT \/ ICP CONTEXT/);
    assert.match(text, /B\. PROSPECT EVIDENCE/);
    assert.ok(text.indexOf("A. PRODUCT") < text.indexOf("B. PROSPECT"));
    const compact = text.length;
    const bulky = JSON.stringify(pack).length;
    assert.ok(compact < bulky, `compact ${compact} vs pack json ${bulky}`);
  });

  it("places contacts in a non-fit section", () => {
    const pack = EVAL_CASES.find((c) => c.id === "contact_is_not_fit").pack;
    const text = formatQualificationUserContent(pack, JSON.stringify(normalizeProductProfile(SAMPLE_PRODUCT_PROFILE)));
    assert.match(text, /NOT fit evidence/);
    assert.match(text, /hello@shop\.example/);
  });
});
