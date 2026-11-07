import test from "node:test";
import assert from "node:assert/strict";
import { scanStore } from "../scan.js";

function res(url, text, status = 200) {
  return { ok: status >= 200 && status < 300, status, text, headers: new Headers(), finalUrl: url };
}
function makeFetch(home) {
  return async (url) => {
    if (url.endsWith("/robots.txt")) return res(url, "User-agent: *\nAllow: /");
    if (url.endsWith("/sitemap.xml")) return res(url, "<urlset><url><loc>https://example.com/</loc></url></urlset>");
    if (url.endsWith("/llms.txt")) return res(url, "Not found", 404);
    if (url.includes("/products.json")) return res(url, "Not found", 404);
    return res(url, home);
  };
}
const meta = '<title>Cart recovery SaaS platform</title><meta name="description" content="Cloud-based software for growing teams">';
test("explicit SaaS metadata avoids ecommerce catalog-only issues", async () => {
  const html = '<html><head>' + meta + '</head><body><main>Subscription platform</main></body></html>';
  const result = await scanStore("https://example.com", { fetchFn: makeFetch(html) });
  assert.equal(result.evidence.checks.siteType.classification, "saas");
  assert.ok(!result.issues.some(x => ["product_schema_missing", "offer_schema_missing", "rating_schema_missing"].includes(x.id)));
  assert.match(result.findings[3].note, /not tested/);
  assert.equal(result.findings.length, 4);
});
test("unknown site retains conservative ecommerce checks", async () => {
  const html = '<html><head><title>Sample Shop</title></head><body>Welcome</body></html>';
  const result = await scanStore("https://example.com", { fetchFn: makeFetch(html) });
  assert.equal(result.evidence.checks.siteType.classification, "commerce_or_unknown");
  assert.ok(result.issues.some(x => x.id === "product_schema_missing"));
  assert.ok(result.issues.some(x => x.id === "offer_schema_missing"));
});
test("generic software wording does not classify SaaS", async () => {
  const html = '<html><head><title>Software accessories shop</title></head><body>Welcome</body></html>';
  const result = await scanStore("https://example.com", { fetchFn: makeFetch(html) });
  assert.equal(result.evidence.checks.siteType.classification, "commerce_or_unknown");
});
