#!/usr/bin/env node
// Read-only staging smoke test. Requires an explicitly supplied staging origin.
// Usage: node scripts/staging-scan-smoke.mjs https://your-preview.vercel.app
import assert from "node:assert/strict";

const raw = process.argv[2];
if (!raw) {
  console.error("Usage: node scripts/staging-scan-smoke.mjs https://your-preview.vercel.app");
  process.exit(2);
}
const origin = new URL(raw);
if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
  throw new Error("Expected a clean HTTPS staging origin.");
}
if (["agenticaso.com", "www.agenticaso.com"].includes(origin.hostname)) {
  throw new Error("Refusing production target: provide a staging/preview origin.");
}
const target = new URL("/api/scan", origin);
const response = await fetch(target, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: "https://cartrenew.com" }),
  signal: AbortSignal.timeout(30000),
  redirect: "manual",
});
assert.equal(response.status, 200, "Expected successful scan API response (check staging auth/access)");
const report = await response.json();
assert.ok(!report.error, "Scan returned an error");
assert.ok(report.evidence?.checkedAt, "Missing scan timestamp");
assert.ok(report.evidence?.checks, "Missing scan evidence");
assert.ok(Array.isArray(report.evidence.checks.productPages), "Missing product page evidence array");
assert.ok(Array.isArray(report.findings) && report.findings.length === 4, "Expected four pillar findings");
assert.ok(Array.isArray(report.issues), "Missing evidence-backed issues");
assert.ok(report.issues.every((issue) => issue.evidence && issue.fix && issue.severity), "Issue lacks evidence/fix/severity");
assert.equal(report.revenue, undefined, "Unverified revenue claim detected");
assert.equal(report.gap, undefined, "Unverified competitor gap detected");
console.log(JSON.stringify({
  target: target.href,
  scannedStore: "https://cartrenew.com",
  checkedAt: report.evidence.checkedAt,
  pillars: report.findings.map(({ t, score }) => ({ pillar: t, score })),
  productPages: report.evidence.checks.productPages,
  issues: report.issues.map(({ id, severity }) => ({ id, severity })),
}, null, 2));
