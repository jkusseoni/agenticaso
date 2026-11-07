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
