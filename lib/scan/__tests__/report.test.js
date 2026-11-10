import test from "node:test";
import assert from "node:assert/strict";
import { scanStore } from "../scan.js";

function mockFetch({ homepage = "<html><title>Store</title><p>Shop our catalog</p></html>", robots = null, sitemap = null, llms = null, feed = null } = {}) {
  return async (url) => {
    let body = null;
    if (url.endsWith("/robots.txt")) body = robots;
    else if (url.endsWith("/sitemap.xml")) body = sitemap;
    else if (url.endsWith("/llms.txt")) body = llms;
    else if (url.includes("/products.json")) body = feed;
    else body = homepage;
    return { ok: body !== null, status: body === null ? 404 : 200, text: body || "", headers: { get: () => null } };
  };
}

test("report provides observed evidence without invented revenue or competitor gap", async () => {
  const result = await scanStore("example.com", { fetchFn: mockFetch() });
  assert.equal(result.clean, "example.com");
  assert.equal(result.findings.length, 4);
  assert.equal(result.revenue, undefined);
  assert.equal(result.gap, undefined);
  assert.ok(result.evidence.checkedAt);
  assert.equal(result.evidence.checks.robots.status, 404);
  assert.ok(result.issues.some(x => x.id === "robots_unverified"));
  assert.ok(result.issues.every(x => x.evidence && x.fix && x.severity));
  assert.match(result.verdict, /not|no AI/i);
});

test("missing robots does not imply AI crawlers were allowed", async () => {
  const result = await scanStore("https://example.com", { fetchFn: mockFetch() });
  const found = result.findings.find(x => x.t === "Found");
  assert.match(found.note, /unknown|not verified/i);
});

test("blocked bots are evidence-backed and not marked as allowed", async () => {
  const result = await scanStore("https://example.com", { fetchFn: mockFetch({ robots: "User-agent: *\nDisallow: /" }) });
  assert.ok(result.issues.some(x => x.id === "bots_blocked"));
  assert.ok(result.evidence.checks.robots.blockedBots.length > 0);
});

test("Shopify detection does not assert checkout or purchase success", async () => {
  const result = await scanStore("https://example.com", { fetchFn: mockFetch({ homepage: "<html><title>Shop</title><p>Shopify.theme products</p></html>" }) });
  assert.equal(result.isShopify, true);
  assert.match(result.findings.find(x => x.t === "Bought").note, /not tested/i);
  assert.doesNotMatch(result.verdict, /could complete a purchase/i);
});

test("rejects credentials and nonstandard URL ports before fetching", async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; throw new Error("should not fetch"); };
  for (const url of ["https://user:password@example.com", "https://example.com:8080"]) {
    const result = await scanStore(url, { fetchFn });
    assert.ok(result.error, url);
  }
  assert.equal(calls, 0);
});

test("samples same-origin product pages and records page-level evidence", async () => {
  const fetched = [];
  const homepage = '<html><title>Store</title><a href="/products/shirt">Shirt</a><a href="https://other.example/products/private">External</a></html>';
  const product = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Shirt","offers":{"@type":"Offer","price":"12","priceCurrency":"USD"}}</script>';
  const fetchFn = async (url) => {
    fetched.push(url);
    return { ok: true, status: 200, text: url.endsWith("/products/shirt") ? product : url === "https://example.com/" ? homepage : "", finalUrl: url, headers: { get: () => null } };
  };
  const result = await scanStore("https://example.com/", { fetchFn });
  assert.equal(result.evidence.checks.productPages.length, 1);
  assert.equal(result.evidence.checks.productPages[0].schema.product, true);
  assert.equal(result.evidence.checks.productPages[0].schema.offer, true);
  assert.ok(!result.issues.some((issue) => issue.id === "product_schema_missing"));
  assert.ok(!fetched.some((url) => url.includes("other.example")));
});

test("ignores product evidence when redirected off origin", async () => {
  const fetchFn = async (url) => ({
    ok: true, status: 200, finalUrl: url.endsWith("/products/shirt") ? "https://external.example/redirect" : url,
    text: url.endsWith("/products/shirt") ? '<script type="application/ld+json">{"@type":"Product"}</script>' : '<a href="/products/shirt">Shirt</a>',
    headers: { get: () => null },
  });
  const result = await scanStore("https://example.com", { fetchFn });
  const page = result.evidence.checks.productPages[0];

  assert.equal(page.status, 200);
  assert.equal(page.reachable, false);
  assert.equal(page.finalUrl, "https://external.example/redirect");
  assert.equal(page.verificationReason, "off_origin_redirect");
  assert.equal(page.schema, null);

  assert.equal(result.evidence.checks.siteType.classification, "unknown");
  assert.ok(!result.issues.some((issue) =>
    ["product_schema_missing", "offer_schema_missing", "rating_schema_missing"].includes(issue.id)
  ));
});

test("samples WooCommerce /product/ URLs and excludes off-site links", async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    const text = url === "https://example.com/"
      ? '<a href="/product/blue-shirt/">Shirt</a><a href="https://outside.example/product/other">External</a>'
      : url === "https://example.com/product/blue-shirt/"
        ? '<script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":"20"}}</script>'
        : "";
    return { ok: true, status: 200, text, finalUrl: url, headers: { get: () => null } };
  };
  const result = await scanStore("https://example.com/", { fetchFn });
  assert.equal(result.evidence.checks.productPages.length, 1);
  assert.equal(result.evidence.checks.productPages[0].url, "https://example.com/product/blue-shirt/");
  assert.equal(result.evidence.checks.productPages[0].schema.product, true);
  assert.ok(!urls.some((url) => url.includes("outside.example")));
});

test("product page HTTP error records verification reason", async () => {
  const fetchFn = async (url) => {
    if (url.endsWith("/products/shirt")) {
      return {
        ok: false, status: 404, finalUrl: url,
        text: "", headers: { get: () => null }
      };
    }

    return {
      ok: true, status: 200, finalUrl: url,
      text: '<a href="/products/shirt">Shirt</a>',
      headers: { get: () => null }
    };
  };

  const result = await scanStore("https://example.com", { fetchFn });
  const page = result.evidence.checks.productPages[0];

  assert.equal(page.status, 404);
  assert.equal(page.reachable, false);
  assert.equal(page.verificationReason, "http_error");
  assert.equal(page.schema, null);
});

test("product page fetch failure records verification reason", async () => {
  const fetchFn = async (url) => {
    if (url.endsWith("/products/shirt")) {
      throw new Error("Simulated fetch failure");
    }

    return {
      ok: true, status: 200, finalUrl: url,
      text: '<a href="/products/shirt">Shirt</a>',
      headers: { get: () => null }
    };
  };

  const result = await scanStore("https://example.com", { fetchFn });
  const page = result.evidence.checks.productPages[0];

  assert.equal(page.status, 0);
  assert.equal(page.reachable, false);
  assert.equal(page.finalUrl, null);
  assert.equal(page.verificationReason, "fetch_error");
  assert.equal(page.schema, null);
});
