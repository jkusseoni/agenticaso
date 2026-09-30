import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CARTRENEW_DOGFOOD_CAMPAIGN,
  classifyDatabaseUrl,
  parseDogfoodUrls,
  planDogfoodSeed,
  validateDogfoodUrl,
  writesAllowed,
  buildCartRenewCampaignData,
} from "../dogfood.js";
import { SIGNAL_KEYS } from "../commerce-signals.js";

describe("cartrenew dogfood seed plan", () => {
  it("uses only supported desiredSignals", () => {
    for (const key of CARTRENEW_DOGFOOD_CAMPAIGN.desiredSignals) {
      assert.equal(SIGNAL_KEYS.includes(key), true);
    }
    const data = buildCartRenewCampaignData("ws_test");
    assert.equal(data.productName, "CartRenew");
    assert.equal(data.targetPlatform, "woocommerce");
    assert.match(data.productDescription, /WhatsApp/);
    assert.equal(/loses lots of carts|increase revenue by 40/i.test(data.productDescription), false);
  });

  it("dry-run is the default without GROWTH_DOGFOOD_CONFIRM", () => {
    const gate = writesAllowed("local", {});
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, "missing_GROWTH_DOGFOOD_CONFIRM");
  });

  it("refuses production writes even with confirm", () => {
    const gate = writesAllowed("production", { GROWTH_DOGFOOD_CONFIRM: "YES" });
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, "PRODUCTION_DB_APPROVAL_REQUIRED");
  });

  it("allows explicit staging classification after confirm", () => {
    const gate = writesAllowed("staging", { GROWTH_DOGFOOD_CONFIRM: "YES" });
    assert.equal(gate.ok, true);
  });

  it("classifies neon hosts as production unless overridden", () => {
    const c = classifyDatabaseUrl("postgresql://u:p@ep-abc.ap-southeast-1.aws.neon.tech/neondb", {});
    assert.equal(c.classification, "production");
    assert.equal(/u:p|password/i.test(JSON.stringify(c)), false);
  });

  it("classifies loopback as local", () => {
    const c = classifyDatabaseUrl("postgresql://postgres:x@127.0.0.1:5432/agenticaso_growth_test", {});
    assert.equal(c.classification, "local");
    assert.equal(c.database, "agenticaso_growth_test");
  });

  it("rejects more than three URLs", () => {
    const parsed = parseDogfoodUrls("https://a.example,https://b.example,https://c.example,https://d.example");
    assert.equal(parsed.ok, false);
  });

  it("rejects credentials, localhost, and private hosts", () => {
    assert.equal(validateDogfoodUrl("https://user:pass@shop.example/").ok, false);
    assert.equal(validateDogfoodUrl("https://localhost/store").ok, false);
    assert.equal(validateDogfoodUrl("https://192.168.1.9/").ok, false);
    assert.equal(validateDogfoodUrl("ftp://shop.example").ok, false);
  });

  it("plans idempotent creates from existing rows", () => {
    const first = planDogfoodSeed({
      workspaceId: "ws1",
      urls: ["https://www.alpha.example/store?utm_source=x"],
    });
    assert.equal(first.ok, true);
    assert.equal(first.wouldCreate.campaigns, 1);
    assert.equal(first.wouldCreate.prospects, 1);
    assert.equal(first.wouldCreate.researchJobs, 1);
    assert.equal(first.prospects[0].identity.canonicalDomain, "alpha.example");

    const second = planDogfoodSeed({
      workspaceId: "ws1",
      urls: ["https://alpha.example/store"],
      existing: {
        campaignId: "camp1",
        prospects: [{ canonicalDomain: "alpha.example" }],
        researchJobs: [{ canonicalDomain: "alpha.example" }],
      },
    });
    assert.equal(second.wouldCreate.campaigns, 0);
    assert.equal(second.wouldCreate.prospects, 0);
    assert.equal(second.wouldCreate.researchJobs, 0);
  });

  it("does not invent prospect URLs when none are supplied", () => {
    const plan = planDogfoodSeed({ workspaceId: "ws1", urls: [] });
    assert.equal(plan.ok, true);
    assert.equal(plan.prospects.length, 0);
    assert.equal(plan.wouldCreate.prospects, 0);
  });
});
