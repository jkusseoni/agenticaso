import test from "node:test";
import assert from "node:assert/strict";
import { scanStore } from "../scan.js";

function response(url, body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: body, headers: new Headers(), finalUrl: url };
}
const homepage = '<html><head><title>Sample SaaS Home</title><meta name="description" content="A useful software service"></head><body><main>Software for teams</main></body></html>';
function mockFetch(url) {
  if (url.endsWith("/robots.txt")) return Promise.resolve(response(url, "User-agent: *\\nAllow: /"));
  if (url.endsWith("/sitemap.xml")) return Promise.resolve(response(url, "<html>Fallback page</html>"));
  if (url.endsWith("/llms.txt")) return Promise.resolve(response(url, "Not found", 404));
  if (url.includes("/products.json")) return Promise.resolve(response(url, "Not found", 404));
  return Promise.resolve(response(url, homepage));
}

test("HTTP 200 HTML sitemap is not reported as valid sitemap XML", async () => {
  const result = await scanStore("https://example.com", { fetchFn: mockFetch });
  assert.equal(result.evidence.checks.sitemap.status, 200);
  assert.equal(result.evidence.checks.sitemap.available, true);
  assert.equal(result.evidence.checks.sitemap.validXmlSignals, false);
  assert.match(result.evidence.checks.sitemap.reason, /XML elements were not detected/);
  assert.ok(result.issues.some(issue => issue.id === "sitemap_missing"));
});

test("scanner report labels use readable Unicode", async () => {
  const result = await scanStore("https://example.com", { fetchFn: mockFetch });
  assert.deepEqual(result.findings.map(f => f.i), ["🔍", "🧩", "⭐", "🛒"]);
});

test("HTML fallback containing loc tag is not accepted as sitemap XML", async () => {
  const fetchFn = async (url) => {
    if (url.endsWith("/sitemap.xml")) {
      return response(
        url,
        "<html><body><loc>https://example.com/page</loc></body></html>"
      );
    }

    return mockFetch(url);
  };

  const result = await scanStore("https://example.com", { fetchFn });

  assert.equal(result.evidence.checks.sitemap.status, 200);
  assert.equal(result.evidence.checks.sitemap.validXmlSignals, false);
  assert.ok(
    result.issues.some(issue => issue.id === "sitemap_missing")
  );
});

test("malformed Shopify product entries do not count as a valid feed", async () => {
  const fetchFn = async (url) => {
    if (url.includes("/products.json")) {
      return response(url, '{"products":[null]}');
    }

    return mockFetch(url);
  };

  const result = await scanStore("https://example.com", { fetchFn });

  assert.equal(result.isShopify, false);
  assert.equal(result.evidence.checks.productFeed.available, true);
  assert.equal(result.evidence.checks.productFeed.validJsonFeed, false);
  assert.equal(result.evidence.checks.siteType.classification, "saas");
});

test("valid Shopify product feed establishes ecommerce evidence", async () => {
  const fetchFn = async (url) => {
    if (url.includes("/products.json")) {
      return response(url, JSON.stringify({
        products: [
          { id: 12345, title: "Running Shoes" }
        ]
      }));
    }

    return mockFetch(url);
  };

  const result = await scanStore("https://example.com", { fetchFn });

  assert.equal(result.isShopify, true);
  assert.equal(result.evidence.checks.productFeed.available, true);
  assert.equal(result.evidence.checks.productFeed.validJsonFeed, true);
  assert.equal(result.evidence.checks.siteType.classification, "ecommerce");
});
