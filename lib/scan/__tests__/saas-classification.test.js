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
test("unknown site does not receive ecommerce-only issues", async () => {
  const html = '<html><head><title>Sample Shop</title></head><body>Welcome</body></html>';
  const result = await scanStore("https://example.com", { fetchFn: makeFetch(html) });
  assert.equal(result.evidence.checks.siteType.classification, "unknown");
  assert.ok(!result.issues.some(x => ["product_schema_missing", "offer_schema_missing", "rating_schema_missing"].includes(x.id)));
  assert.match(result.findings.find(x => x.key === "transact").note, /unverified/);
});
test("generic software wording does not classify SaaS", async () => {
  const html = '<html><head><title>Software accessories shop</title></head><body>Welcome</body></html>';
  const result = await scanStore("https://example.com", { fetchFn: makeFetch(html) });
  assert.equal(result.evidence.checks.siteType.classification, "unknown");
});

test("merchant-facing cart recovery SaaS without explicit SaaS metadata is classified from independent signals", async () => {
  const html = '<html><head><title>Cart Recovery on WhatsApp</title></head><body><h1>Recover abandoned carts on WhatsApp</h1><p>AI-powered automation platform for Shopify and WooCommerce stores. Install our plugin and connect your store.</p><section><h2>Pricing plans</h2><p>Starter $12/month. Start free trial.</p></section></body></html>';
  const result = await scanStore("https://example.com", { fetchFn: makeFetch(html) });
  assert.equal(result.evidence.checks.siteType.classification, "saas");
  assert.match(result.evidence.checks.siteType.basis, /workflow signals/);
  assert.ok(!result.issues.some(x => ["product_schema_missing", "offer_schema_missing", "rating_schema_missing"].includes(x.id)));
});
test("ecommerce store mentioning WhatsApp and pricing is not misclassified", async () => {
  const html = '<html><head><title>Shop apparel</title></head><body><h1>Buy shirts</h1><p>WhatsApp support and pricing for products. Checkout and add to cart.</p></body></html>';
  const result = await scanStore("https://example.com", { fetchFn: makeFetch(html) });
  assert.equal(result.evidence.checks.siteType.classification, "unknown");
});

test("SaaS conversion evidence reports presence only, without claiming checkout success", async () => {
  const html = '<html><head><title>Subscription software SaaS</title></head><body><h1>Pricing plans</h1><p>Start free trial, $12 per month.</p><a href="/pricing">Pricing</a><a href="/signup">Create account</a></body></html>';
  const result = await scanStore("https://example.com", { fetchFn: makeFetch(html) });
  const signals = result.evidence.checks.saasConversion;
  assert.equal(signals.pricingMention, true);
  assert.equal(signals.pricingLink, true);
  assert.equal(signals.trialMention, true);
  assert.equal(signals.signupLink, true);
  assert.match(signals.scope, /no navigation, registration, billing or conversion executed/);
});
test("Unknown sites do not get SaaS-only conversion evidence", async () => {
  const result = await scanStore("https://example.com", { fetchFn: makeFetch("<html><title>Shop</title><body>Products</body></html>") });
  assert.equal(result.evidence.checks.saasConversion, undefined);
});

test("SaaS conversion score uses discovered signals but never claims verified checkout", async () => {
  const html = '<html><head><title>SaaS software platform</title></head><body><h1>Pricing plans</h1><p>Start free trial. $12 per month. Add to cart checkout.</p><a href="/pricing">Pricing</a><a href="/signup">Create account</a></body></html>';
  const result = await scanStore("https://example.com", { fetchFn: makeFetch(html) });
  const bought = result.findings.find(f => f.key === "transact");
  const understood = result.findings.find(f => f.key === "understand");
  assert.equal(result.evidence.checks.siteType.classification, "saas");
  assert.equal(bought.score, 48);
  assert.equal(bought.ok, false);
  assert.match(bought.q, /SaaS signup/);
  assert.match(understood.q, /service and software/);
  assert.match(bought.note, /not tested/);
});
test("SaaS without conversion links does not inherit ecommerce cart bonuses", async () => {
  const html = '<html><head><title>Subscription software SaaS</title></head><body><p>Add to cart checkout /cart</p></body></html>';
  const result = await scanStore("https://example.com", { fetchFn: makeFetch(html) });
  assert.equal(result.findings.find(f => f.key === "transact").score, 22);
});

test("Shopify detection without product verification avoids unsupported schema issues", async () => {
  const html = '<html><head><title>Clothing Store</title></head><body><script>window.Shopify = { theme: {} };</script><h1>Shirts</h1></body></html>';

  const result = await scanStore("https://example.com", {
    fetchFn: makeFetch(html)
  });

  assert.equal(result.evidence.checks.siteType.classification, "ecommerce");
  assert.equal(result.evidence.checks.productPages.length, 0);

  for (const id of [
    "product_schema_missing",
    "offer_schema_missing",
    "rating_schema_missing"
  ]) {
    assert.equal(result.issues.some(issue => issue.id === id), false);
  }
});

test("verified Shopify product page without schema produces ecommerce issues", async () => {
  const html = '<html><head><title>Clothing Store</title></head><body><script>window.Shopify = { theme: {} };</script><a href="/products/blue-shirt">Blue Shirt</a></body></html>';

  const fetchFn = async (url) => {
    if (url === "https://example.com/products/blue-shirt") {
      return res(url, "<html><body><h1>Blue Shirt</h1></body></html>");
    }

    return makeFetch(html)(url);
  };

  const result = await scanStore("https://example.com", { fetchFn });

  assert.equal(result.evidence.checks.siteType.classification, "ecommerce");
  assert.equal(result.evidence.checks.productPages[0].reachable, true);

  assert.ok(result.issues.some(issue => issue.id === "product_schema_missing"));
  assert.ok(result.issues.some(issue => issue.id === "offer_schema_missing"));
});

test("generic website receives no ecommerce-only fixes", async () => {
  const html = '<html><head><title>Example Domain</title></head><body><h1>Example Domain</h1><p>Information for illustrative examples.</p></body></html>';
  const result = await scanStore("https://example.com", { fetchFn: makeFetch(html) });
  assert.equal(result.evidence.checks.siteType.classification, "unknown");
  assert.ok(!result.issues.some(x => ["product_schema_missing", "offer_schema_missing", "rating_schema_missing"].includes(x.id)));
  assert.doesNotMatch(result.findings.find(x => x.key === "understand").note, /Product schema/);
});
test("reachable WooCommerce product page establishes ecommerce evidence", async () => {
  const homepage = '<html><head><title>Clothing</title></head><body><a href="/product/blue-shirt/">Blue Shirt</a></body></html>';
  const product = '<script type="application/ld+json">{"@type":"Product","name":"Blue Shirt"}</script>';
  const fetchFn = async (url) => {
    const isProduct = url.endsWith("/product/blue-shirt/");
    const text = isProduct ? product : url === "https://example.com/" ? homepage : "";
    return res(url, text, text ? 200 : 404);
  };
  const result = await scanStore("https://example.com", { fetchFn });
  assert.equal(result.evidence.checks.siteType.classification, "ecommerce");
  assert.equal(result.evidence.checks.productPages[0].reachable, true);
  assert.ok(result.issues.some(x => x.id === "offer_schema_missing"));
});
