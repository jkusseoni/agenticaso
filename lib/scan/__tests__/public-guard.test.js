import test from "node:test";
import assert from "node:assert/strict";
import { _resetRateLimitsForTests } from "../../api/rate-limit.js";
import { publicScanLimited, readPublicScanBody, PUBLIC_SCAN_MAX_BYTES, PUBLIC_SCAN_PER_HOUR } from "../public-guard.js";

test("public scan accepts a bounded URL JSON request", async () => {
  const result = await readPublicScanBody(new Request("https://example.com/api/scan", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://cartrenew.com" })
  }));
  assert.equal(result.body.url, "https://cartrenew.com");
});

test("public scan rejects oversized and malformed bodies", async () => {
  const oversized = new Request("https://example.com/api/scan", { method: "POST", body: "x".repeat(PUBLIC_SCAN_MAX_BYTES + 1) });
  assert.equal((await readPublicScanBody(oversized)).error, "too_large");
  const malformed = new Request("https://example.com/api/scan", { method: "POST", body: "{" });
  assert.equal((await readPublicScanBody(malformed)).error, "invalid");
});

test("public scan has a per-instance hourly request ceiling", () => {
  _resetRateLimitsForTests();
  const request = new Request("https://example.com/api/scan", { headers: { "x-vercel-forwarded-for": "198.51.100.7" } });
  for (let i = 0; i < PUBLIC_SCAN_PER_HOUR; i++) assert.equal(publicScanLimited(request), false);
  assert.equal(publicScanLimited(request), true);
  _resetRateLimitsForTests();
});
