import assert from "node:assert/strict";
import test from "node:test";
import { _resetRateLimitsForTests, rateLimited } from "../rate-limit.js";
import { publicScanLimited, PUBLIC_SCAN_PER_HOUR } from "../../scan/public-guard.js";

function request(headers) {
  return new Request("https://example.com/api/scan", { headers });
}

test("public scan ignores x-forwarded-for and shares the fallback bucket", () => {
  _resetRateLimitsForTests();
  const first = request({ "x-forwarded-for": "203.0.113.4" });
  const second = request({ "x-forwarded-for": "203.0.113.9" });
  const missing = request({});
  for (let i = 0; i < PUBLIC_SCAN_PER_HOUR; i++) assert.equal(publicScanLimited(first), false);
  assert.equal(publicScanLimited(second), true);
  assert.equal(publicScanLimited(missing), true);
  _resetRateLimitsForTests();
});

test("public scan limits each x-vercel-forwarded-for address separately", () => {
  _resetRateLimitsForTests();
  const one = request({ "x-vercel-forwarded-for": "198.51.100.10, 10.0.0.1" });
  const two = request({ "x-vercel-forwarded-for": "198.51.100.11" });
  for (let i = 0; i < PUBLIC_SCAN_PER_HOUR; i++) assert.equal(publicScanLimited(one), false);
  assert.equal(publicScanLimited(one), true);
  assert.equal(publicScanLimited(two), false);
  _resetRateLimitsForTests();
});

test("in-memory rate limit keeps existing keys when the map is full", () => {
  _resetRateLimitsForTests();
  assert.equal(rateLimited("known-a", 1, 2), false);
  assert.equal(rateLimited("known-b", 1, 2), false);
  assert.equal(rateLimited("new-c", 1, 2), false);
  assert.equal(rateLimited("new-d", 1, 2), true);
  assert.equal(rateLimited("known-a", 1, 2), true);
  assert.equal(rateLimited("known-b", 1, 2), true);
  _resetRateLimitsForTests();
});
