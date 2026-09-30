import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectWooCommerce, WOO_STATUS } from "../woocommerce.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name) {
  return fs.readFileSync(path.join(fixturesDir, name), "utf8");
}

function ids(result) {
  return result.evidence.map((e) => e.extractor);
}

describe("detectWooCommerce", () => {
  it("returns inconclusive for empty input", () => {
    const result = detectWooCommerce({});
    assert.equal(result.status, WOO_STATUS.INCONCLUSIVE);
    assert.deepEqual(result.evidence, []);
  });

  it("verifies WooCommerce from plugin assets, generator, body class, and wc-ajax", () => {
    const result = detectWooCommerce({
      finalUrl: "https://shop.example/",
      html: fixture("woo-home.html"),
    });
    assert.equal(result.status, WOO_STATUS.VERIFIED);
    assert.ok(ids(result).includes("woocommerce_plugin_path"));
    assert.ok(ids(result).includes("woocommerce_generator_meta"));
    assert.ok(ids(result).includes("woocommerce_body_class"));
    assert.ok(ids(result).includes("wc_ajax"));
    for (const row of result.evidence) {
      assert.equal(row.verificationStatus, "observed");
      assert.ok(row.observedData);
      assert.ok(row.claim);
      assert.equal(typeof row.confidence, "number");
    }
  });

  it("verifies from observed wc REST path without HTML", () => {
    const result = detectWooCommerce({
      finalUrl: "https://shop.example/",
      observedPaths: ["https://shop.example/wp-json/wc/v3/products"],
    });
    assert.equal(result.status, WOO_STATUS.VERIFIED);
    assert.ok(ids(result).includes("woocommerce_rest_api"));
  });

  it("verifies from WooCommerce session cookie headers", () => {
    const result = detectWooCommerce({
      finalUrl: "https://shop.example/",
      headers: {
        "set-cookie": "wp_woocommerce_session_abc=1; Path=/",
      },
    });
    assert.equal(result.status, WOO_STATUS.VERIFIED);
    assert.ok(ids(result).includes("woocommerce_session_cookie"));
  });

  it("treats WordPress-only sites as inconclusive, not not_woocommerce", () => {
    const result = detectWooCommerce({
      finalUrl: "https://blog.example/",
      html: fixture("wp-blog.html"),
    });
    assert.equal(result.status, WOO_STATUS.INCONCLUSIVE);
    assert.equal(ids(result).some((id) => id.startsWith("woocommerce_")), false);
    assert.equal(ids(result).includes("wordpress_without_woocommerce"), false);
  });

  it("does not treat a generic /shop page as WooCommerce", () => {
    const result = detectWooCommerce({
      finalUrl: "https://boutique.example/shop",
      html: fixture("generic-shop.html"),
      observedPaths: ["/shop", "/cart", "/checkout"],
    });
    assert.equal(result.status, WOO_STATUS.INCONCLUSIVE);
    assert.equal(
      result.evidence.some((e) => e.extractor.startsWith("woocommerce_")),
      false
    );
  });

  it("marks Shopify stores as not WooCommerce", () => {
    const result = detectWooCommerce({
      finalUrl: "https://demo.myshopify.com/",
      html: fixture("shopify.html"),
      headers: { "x-shopid": "123" },
    });
    assert.equal(result.status, WOO_STATUS.NOT_WOOCOMMERCE);
    assert.ok(ids(result).includes("alternate_shopify"));
  });

  it("treats a lone marketing mention of WooCommerce as inconclusive", () => {
    const result = detectWooCommerce({
      finalUrl: "https://agency.example/blog/we-build-woocommerce-stores",
      html: "<html><body><p>We build WooCommerce and Shopify stores.</p></body></html>",
    });
    assert.equal(result.status, WOO_STATUS.INCONCLUSIVE);
  });

  it("accepts supplied script URLs as observed plugin evidence", () => {
    const result = detectWooCommerce({
      finalUrl: "https://shop.example/",
      scriptUrls: [
        "https://shop.example/wp-content/plugins/woocommerce/assets/js/frontend/cart.min.js",
      ],
    });
    assert.equal(result.status, WOO_STATUS.VERIFIED);
    assert.equal(result.evidence[0].sourceType, "path");
    assert.match(result.evidence[0].sourceUrl, /woocommerce/);
  });

  it("does not fetch or invent contacts, people, or platforms", () => {
    const result = detectWooCommerce({
      html: "<p>Contact Jane Doe, Founder at jane@shop.example</p>",
    });
    assert.equal(result.status, WOO_STATUS.INCONCLUSIVE);
    assert.deepEqual(result.evidence, []);
  });

  it("classifies a WooCommerce JS script src as script, not stylesheet", () => {
    const result = detectWooCommerce({
      finalUrl: "https://shop.example/",
      html: `<script src="https://shop.example/assets/woocommerce.min.js"></script>`,
    });
    const row = result.evidence.find((e) => e.extractor === "woocommerce_asset_filename");
    assert.ok(row);
    assert.equal(row.sourceType, "script");
    assert.match(row.sourceUrl, /woocommerce\.min\.js/);
    assert.equal(row.sourceType === "stylesheet", false);
  });

  it("classifies a WooCommerce stylesheet link as stylesheet", () => {
    const result = detectWooCommerce({
      finalUrl: "https://shop.example/",
      html: `<link rel="stylesheet" href="https://shop.example/assets/woocommerce.css">`,
    });
    const row = result.evidence.find((e) => e.extractor === "woocommerce_asset_filename");
    assert.ok(row);
    assert.equal(row.sourceType, "stylesheet");
  });

  it("does not treat an anchor to a .js URL as stylesheet evidence", () => {
    const result = detectWooCommerce({
      finalUrl: "https://shop.example/",
      html: `<a href="https://shop.example/assets/woocommerce.min.js">file</a>`,
    });
    assert.equal(
      result.evidence.some((e) => e.extractor === "woocommerce_asset_filename"),
      false
    );
  });
});
