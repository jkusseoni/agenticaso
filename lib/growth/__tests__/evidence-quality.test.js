import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractPublicContacts, CONTACT_KIND } from "../extract-contacts.js";
import { extractTypedAssets } from "../html-assets.js";
import { detectWooCommerce, WOO_STATUS } from "../woocommerce.js";
import { extractCommerceSignals, SIGNAL_STATUS } from "../commerce-signals.js";
import { buildEvidencePack, EVIDENCE_PACK_BOUNDS } from "../evidence-pack.js";
import { packToEvidenceRows, assertSanitizedEvidenceRows } from "../persist-run.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name) {
  return fs.readFileSync(path.join(fixturesDir, name), "utf8");
}

function contactUrls(html, finalUrl = "https://coraandspink.com/") {
  return extractPublicContacts({ finalUrl, html }).contacts
    .filter((c) => c.kind === CONTACT_KIND.CONTACT_URL)
    .map((c) => c.value);
}

describe("evidence quality hardening", () => {
  it("1. accepts /contact/", () => {
    assert.deepEqual(
      contactUrls(`<a href="/contact/">Contact</a>`),
      ["https://coraandspink.com/contact/"]
    );
  });

  it("2. normalizes /contact/# to /contact/", () => {
    assert.deepEqual(
      contactUrls(`<a href="/contact/#">Contact</a>`),
      ["https://coraandspink.com/contact/"]
    );
  });

  it("3. deduplicates /contact/#foo with /contact/", () => {
    const urls = contactUrls(`
      <a href="/contact/">Contact</a>
      <a href="/contact/#foo">Contact</a>
    `);
    assert.deepEqual(urls, ["https://coraandspink.com/contact/"]);
  });

  it("4. rejects fragment-only #searchbox", () => {
    assert.deepEqual(contactUrls(`<a href="#searchbox">Contact</a>`), []);
  });

  it("5. rejects fragment-only #ajax-content-wrap", () => {
    assert.deepEqual(contactUrls(`<a href="#ajax-content-wrap">Contact</a>`), []);
  });

  it("6. rejects fragment-only #slide-out-widget-area", () => {
    assert.deepEqual(contactUrls(`<a href="#slide-out-widget-area">Contact us</a>`), []);
  });

  it("7. classifies script src *.js as script", () => {
    const typed = extractTypedAssets(
      `<script src="https://shop.example/assets/woocommerce.min.js"></script>`,
      "https://shop.example/"
    );
    assert.ok(typed.scriptUrls.some((u) => /woocommerce\.min\.js/.test(u)));
    assert.equal(typed.stylesheetUrls.some((u) => /woocommerce\.min\.js/.test(u)), false);
    const woo = detectWooCommerce({
      finalUrl: "https://shop.example/",
      html: `<script src="https://shop.example/assets/woocommerce.min.js"></script>`,
    });
    const row = woo.evidence.find((e) => e.extractor === "woocommerce_asset_filename");
    assert.equal(row.sourceType, "script");
  });

  it("8. classifies link rel=stylesheet as stylesheet", () => {
    const typed = extractTypedAssets(
      `<link rel="stylesheet" href="https://shop.example/assets/woocommerce.css">`,
      "https://shop.example/"
    );
    assert.ok(typed.stylesheetUrls.some((u) => /woocommerce\.css/.test(u)));
    assert.equal(typed.scriptUrls.some((u) => /woocommerce\.css/.test(u)), false);
    const woo = detectWooCommerce({
      finalUrl: "https://shop.example/",
      html: `<link href="https://shop.example/assets/woocommerce.css" rel="stylesheet">`,
    });
    const row = woo.evidence.find((e) => e.extractor === "woocommerce_asset_filename");
    assert.equal(row.sourceType, "stylesheet");
  });

  it("9. WooCommerce JS resource remains valid Woo evidence", () => {
    const result = detectWooCommerce({
      finalUrl: "https://shop.example/",
      html: `<script src="/wp-content/plugins/woocommerce/assets/js/frontend/woocommerce.min.js"></script>`,
    });
    assert.equal(result.status, WOO_STATUS.VERIFIED);
    assert.ok(result.evidence.some((e) => e.extractor === "woocommerce_plugin_path"));
    assert.ok(
      result.evidence.some(
        (e) => e.extractor === "woocommerce_asset_filename" && e.sourceType === "script"
      )
    );
  });

  it("10. isolated currency amount does not become product-price evidence", () => {
    const result = extractCommerceSignals({
      html: `<p>Prices from £6.00 and £15.00</p>`,
    });
    assert.deepEqual(result.signals.high_ticket.prices, []);
    assert.equal(
      result.signals.high_ticket.evidence.some((e) => /product price/i.test(e.claim)),
      false
    );
  });

  it("11. Product JSON-LD price can produce supported product-price evidence", () => {
    const result = extractCommerceSignals({
      html: `<script type="application/ld+json">
        {"@type":"Product","offers":{"@type":"Offer","price":"24.00","priceCurrency":"GBP"}}
      </script>`,
    });
    assert.ok(result.signals.high_ticket.prices.some((p) => p.amount === 24));
    assert.ok(
      result.signals.high_ticket.evidence.some(
        (e) => e.extractor === "observed_price" && e.sourceType === "schema"
      )
    );
  });

  it("12. Woo product-card price can produce supported product-price evidence", () => {
    const result = extractCommerceSignals({
      html: `<li class="product">
        <span class="woocommerce-Price-amount amount">£15.00</span>
      </li>`,
    });
    assert.ok(result.signals.high_ticket.prices.some((p) => p.amount === 15));
    assert.ok(
      result.signals.high_ticket.evidence.some(
        (e) => e.extractor === "observed_price" && /product markup/i.test(e.claim)
      )
    );
  });

  it("13. isolated delivery does not establish shipping_complexity", () => {
    const result = extractCommerceSignals({ html: `<p>delivery</p>` });
    assert.equal(result.signals.shipping_complexity.status, SIGNAL_STATUS.UNKNOWN);
  });

  it("14. isolated delivery does not create misleading strong evidence", () => {
    const result = extractCommerceSignals({ html: `<footer>delivery</footer>` });
    assert.deepEqual(result.signals.shipping_complexity.evidence, []);
    assert.equal(
      result.signals.shipping_complexity.evidence.some((e) => /checkout|complexity|international/i.test(e.claim)),
      false
    );
  });

  it("15. concrete shipping statement remains extractable", () => {
    const result = extractCommerceSignals({
      html: `<p>Free shipping over £50. Ships to 12 countries.</p>`,
    });
    assert.ok(result.signals.shipping_complexity.facts.includes("free_shipping_threshold"));
    assert.ok(result.signals.shipping_complexity.facts.includes("shipping_destinations"));
    assert.ok(result.signals.shipping_complexity.evidence.length >= 2);
  });

  it("16. Apple Pay wording does not become a stronger checkout claim without checkout context", () => {
    const result = extractCommerceSignals({ html: `<p>Apple Pay</p>` });
    const row = result.signals.multiple_payments.evidence.find((e) => e.extractor === "payment_apple_pay");
    assert.equal(row.claim, "Apple Pay text was observed.");
    assert.equal(/confirmed available at checkout/i.test(row.claim), false);
  });

  it("17. Google Pay same behavior", () => {
    const result = extractCommerceSignals({ html: `<p>Google Pay</p>` });
    const row = result.signals.multiple_payments.evidence.find((e) => e.extractor === "payment_google_pay");
    assert.equal(row.claim, "Google Pay text was observed.");
    assert.equal(/confirmed available at checkout/i.test(row.claim), false);
  });

  it("18. literal mailto email is still extracted", () => {
    const result = extractPublicContacts({
      finalUrl: "https://coraandspink.com/",
      html: `<a href="mailto:info@coraandspink.com">Email</a>`,
    });
    const emails = result.contacts.filter((c) => c.kind === CONTACT_KIND.EMAIL).map((c) => c.value);
    assert.deepEqual(emails, ["info@coraandspink.com"]);
  });

  it("19. no guessed email", () => {
    const result = extractPublicContacts({
      finalUrl: "https://coraandspink.com/",
      html: `<p>Cora Smith, Founder. coraandspink.com</p>`,
    });
    const emails = result.contacts.filter((c) => c.kind === CONTACT_KIND.EMAIL);
    assert.deepEqual(emails, []);
    assert.equal(JSON.stringify(result).includes("cora@"), false);
    assert.equal(JSON.stringify(result).includes("info@coraandspink.com"), false);
  });

  it("20. existing WooCommerce detector fixtures remain passing", () => {
    const verified = detectWooCommerce({
      finalUrl: "https://shop.example/",
      html: fixture("woo-home.html"),
    });
    assert.equal(verified.status, WOO_STATUS.VERIFIED);
    const blog = detectWooCommerce({
      finalUrl: "https://blog.example/",
      html: fixture("wp-blog.html"),
    });
    assert.equal(blog.status, WOO_STATUS.INCONCLUSIVE);
    const generic = detectWooCommerce({
      finalUrl: "https://boutique.example/shop",
      html: fixture("generic-shop.html"),
    });
    assert.equal(generic.status, WOO_STATUS.INCONCLUSIVE);
    const shopify = detectWooCommerce({
      finalUrl: "https://demo.myshopify.com/",
      html: fixture("shopify.html"),
      headers: { "x-shopid": "123" },
    });
    assert.equal(shopify.status, WOO_STATUS.NOT_WOOCOMMERCE);
  });

  it("21. no raw HTML persistence", () => {
    const analysis = {
      woocommerce: detectWooCommerce({
        finalUrl: "https://shop.example/",
        html: fixture("woo-home.html"),
      }),
      commerceSignals: extractCommerceSignals({
        html: `<p>Free shipping over £50. PayPal and Visa at checkout.</p>
          <a href="mailto:hello@shop.example">x</a>`,
      }),
      contacts: extractPublicContacts({
        finalUrl: "https://shop.example/",
        html: `<a href="mailto:hello@shop.example">x</a><a href="/contact/">Contact</a>`,
      }),
    };
    const pack = buildEvidencePack({
      collection: {
        root: { requestedUrl: "https://shop.example/", finalUrl: "https://shop.example/" },
        pages: [],
        usage: {},
        warnings: [],
      },
      analysis,
    });
    assert.equal(pack.notes.htmlOmitted, true);
    assert.ok(!Object.prototype.hasOwnProperty.call(pack, "html"));
    const blob = JSON.stringify(pack);
    assert.equal(/<!DOCTYPE|<html[\s>]|<\/html>/i.test(blob), false);
    const rows = packToEvidenceRows(pack, { prospectId: "p1", jobId: "j1", runId: "r1" });
    assertSanitizedEvidenceRows(rows);
  });

  it("22. Evidence Pack limits remain enforced", () => {
    const evidence = [];
    for (let i = 0; i < 50; i += 1) {
      evidence.push({
        claim: `Claim ${i} ${"x".repeat(400)}`,
        sourceUrl: `https://shop.example/p/${i}`,
        sourceType: "html",
        observedData: "y".repeat(500),
        confidence: 0.5,
        verificationStatus: "observed",
        extractor: `row_${i}`,
      });
    }
    const pack = buildEvidencePack({
      collection: { root: {}, pages: [], usage: {}, warnings: [] },
      analysis: {
        woocommerce: { status: "inconclusive", evidence },
        commerceSignals: { signals: {} },
        contacts: { contacts: [] },
      },
    });
    assert.ok(pack.evidence.length <= EVIDENCE_PACK_BOUNDS.maxEvidence);
    assert.equal(pack.collectionMeta.omittedEvidenceCount, 50 - EVIDENCE_PACK_BOUNDS.maxEvidence);
    assert.ok(pack.evidence.every((e) => e.observedData.length <= EVIDENCE_PACK_BOUNDS.maxObservedData));
    assert.ok(pack.evidence.every((e) => e.claim.length <= EVIDENCE_PACK_BOUNDS.maxClaim));
  });
});
