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

test("unverified product pages do not trigger missing schema claims", async () => {
  const productUrl = "https://example.com/products/running-shoes";

  const fetchFn = async (url) => {
    if (url.includes("/products.json")) {
      return response(url, JSON.stringify({
        products: [{ id: 12345, title: "Running Shoes" }]
      }));
    }

    if (url === productUrl) {
      return {
        ...response(url, "<html><body>Redirected</body></html>"),
        finalUrl: "https://external.example/products/running-shoes"
      };
    }

    if (url === "https://example.com/") {
      return response(url, `
        <html>
          <head><title>Running Shoes Store</title></head>
          <body>
            <a href="/products/running-shoes">Running Shoes</a>
          </body>
        </html>
      `);
    }

    return mockFetch(url);
  };

  const result = await scanStore("https://example.com", { fetchFn });

  assert.equal(result.evidence.checks.siteType.classification, "ecommerce");
  assert.equal(result.evidence.checks.productFeed.validJsonFeed, true);

  assert.ok(
    result.evidence.checks.productPages.some(page => !page.reachable)
  );

  for (const id of [
    "product_schema_missing",
    "offer_schema_missing",
    "rating_schema_missing"
  ]) {
    assert.equal(
      result.issues.some(issue => issue.id === id),
      false,
      `${id} must not be claimed without verified product-page evidence`
    );
  }
});
test("unverified ecommerce product page gives neutral findings", async () => {
  const productUrl = "https://example.com/products/shoes";

  const fetchFn = async (url) => {
    if (url.includes("/products.json")) {
      return response(url, JSON.stringify({
        products: [{ id: 1, title: "Shoes" }]
      }));
    }

    if (url === "https://example.com/") {
      return response(url, '<html><a href="/products/shoes">Shoes</a></html>');
    }

    if (url === productUrl) {
      return {
        ...response(url, "<html>Product</html>"),
        finalUrl: "https://www.example.com/products/shoes"
      };
    }

    return mockFetch(url);
  };

  const result = await scanStore("https://example.com", { fetchFn });

  assert.equal(result.evidence.checks.siteType.classification, "ecommerce");
  assert.equal(result.evidence.checks.productPages[0].verificationReason, "off_origin_redirect");

  for (const finding of result.findings.slice(1)) {
    assert.match(finding.note, /could not be verified/i);
  }

  assert.ok(!result.issues.some(issue =>
    ["product_schema_missing", "rating_schema_missing", "offer_schema_missing"].includes(issue.id)
  ));
});

test("homepage positive schema remains visible without verified product pages", async () => {
  const fetchFn = async (url) => {
    if (url.includes("/products.json")) {
      return response(url, JSON.stringify({
        products: [{ id: 1, title: "Shoes" }]
      }));
    }

    if (url === "https://example.com/") {
      return response(url, `
        <html><head>
          <script type="application/ld+json">
          {
            "@context":"https://schema.org",
            "@type":"Product",
            "name":"Shoes",
            "offers":{"@type":"Offer","price":"99"},
            "aggregateRating":{"@type":"AggregateRating","ratingValue":"4.5"}
          }
          </script>
        </head><body>Shoes</body></html>
      `);
    }

    return mockFetch(url);
  };

  const result = await scanStore("https://example.com", { fetchFn });

  assert.equal(result.evidence.checks.siteType.classification, "ecommerce");
  assert.equal(result.evidence.checks.productPages.length, 0);

  assert.match(result.findings[1].note, /Product schema|structured data present/i);
  assert.match(result.findings[2].note, /markup detected/i);
  assert.match(result.findings[3].note, /markup detected/i);
});