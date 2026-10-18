/**
 * Homepage billing view: server-derived Pro only, scoped to the signed-in user.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  billingRequestKey,
  deriveBillingView,
  ownedRunView,
  parseBillingStatus,
} from "../client-view.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function proResult(userId, attempt = 0) {
  return { key: billingRequestKey(userId, attempt), error: false, isPaid: true, priceLabel: "$19/month" };
}

describe("homepage billing view", () => {
  it("waits for Clerk before deciding anything", () => {
    const view = deriveBillingView({ isLoaded: false, isSignedIn: true, userId: "user_a", result: proResult("user_a") });
    assert.equal(view.state, "loading");
    assert.equal(view.isPaid, false);
  });

  it("shows the logged-out state even when a previous Pro result is still in memory", () => {
    const view = deriveBillingView({ isLoaded: true, isSignedIn: false, userId: null, result: proResult("user_a") });
    assert.equal(view.state, "signed_out");
    assert.equal(view.isPaid, false);
  });

  it("does not show account A's Pro entitlement to account B", () => {
    const stale = proResult("user_a");
    const view = deriveBillingView({ isLoaded: true, isSignedIn: true, userId: "user_b", result: stale });
    assert.equal(view.state, "loading");
    assert.equal(view.isPaid, false);

    const free = { key: billingRequestKey("user_b"), error: false, isPaid: false, priceLabel: "$19/month" };
    const after = deriveBillingView({ isLoaded: true, isSignedIn: true, userId: "user_b", result: free });
    assert.equal(after.state, "free");
    assert.equal(after.isPaid, false);
    assert.equal(after.priceLabel, "$19/month");
  });

  it("shows Pro only for the matching user and attempt", () => {
    const view = deriveBillingView({ isLoaded: true, isSignedIn: true, userId: "user_a", result: proResult("user_a") });
    assert.equal(view.state, "pro");
    assert.equal(view.isPaid, true);

    const retrying = deriveBillingView({ isLoaded: true, isSignedIn: true, userId: "user_a", attempt: 1, result: proResult("user_a", 0) });
    assert.equal(retrying.state, "loading");
    assert.equal(retrying.isPaid, false);
  });

  it("treats a failed status request as an error, never as Pro", () => {
    const result = { key: billingRequestKey("user_a"), error: true, isPaid: true, priceLabel: "$19/month" };
    const view = deriveBillingView({ isLoaded: true, isSignedIn: true, userId: "user_a", result });
    assert.equal(view.state, "error");
    assert.equal(view.isPaid, false);
  });

  it("reads only the server-derived isPaid boolean and price label", () => {
    assert.deepEqual(parseBillingStatus({ billing: { isPaid: true }, pricing: { pro: { label: " $19/month " } } }), {
      isPaid: true,
      priceLabel: "$19/month",
    });
    assert.equal(parseBillingStatus({ billing: { isPaid: "true" } }).isPaid, false);
    assert.equal(parseBillingStatus({ publicMetadata: { paid: true } }).isPaid, false);
    assert.equal(parseBillingStatus(null).priceLabel, null);
    assert.equal(parseBillingStatus({ pricing: { pro: { label: 499 } } }).priceLabel, null);
  });

  it("hides a finished visibility run from a different or logged-out user", () => {
    const run = { owner: "user_a", status: "done", data: { overall: 80 }, err: "" };
    assert.equal(ownedRunView(run, "user_a").status, "done");
    assert.deepEqual(ownedRunView(run, "user_b"), { status: "idle", data: null, err: "" });
    assert.deepEqual(ownedRunView(run, null), { status: "idle", data: null, err: "" });
  });

  it("homepage no longer trusts Clerk metadata or a hard-coded price", () => {
    const page = fs.readFileSync(path.join(repoRoot, "app/page.js"), "utf8");
    const start = page.indexOf("function AIVisibility");
    const end = page.indexOf("function ctaBtn");
    const section = page.slice(start, end);
    assert.ok(start > 0 && end > start);
    assert.equal(section.includes("publicMetadata"), false);
    assert.equal(section.includes("₹499"), false);
    assert.ok(section.includes("/api/billing/status"));
    assert.ok(section.includes("deriveBillingView"));
    assert.ok(section.includes("billing.priceLabel"));
  });
});
