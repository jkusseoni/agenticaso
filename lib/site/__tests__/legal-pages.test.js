import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LEGAL_NAV, getPublicSupportEmail, LEGAL_EFFECTIVE_DATE } from "../public-config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("public legal pages", () => {
  it("exposes the four required public routes in footer nav", () => {
    const hrefs = LEGAL_NAV.map((i) => i.href);
    assert.deepEqual(hrefs, ["/terms", "/privacy", "/refund-cancellation", "/contact"]);
  });

  it("has page modules for required routes", () => {
    for (const rel of [
      "app/terms/page.js",
      "app/privacy/page.js",
      "app/refund-cancellation/page.js",
      "app/contact/page.js",
    ]) {
      assert.ok(fs.existsSync(path.join(root, rel)), `missing ${rel}`);
    }
  });

  it("refund policy uses canonical plan price helper, not a hard-coded 499", () => {
    const text = fs.readFileSync(path.join(root, "app/refund-cancellation/page.js"), "utf8");
    assert.ok(text.includes("DEFAULT_PRO_PRICE_LABEL"));
    assert.ok(!text.includes("₹499"));
  });

  it("does not invent GSTIN or phone numbers on contact/refund pages", () => {
    for (const rel of ["app/contact/page.js", "app/refund-cancellation/page.js"]) {
      const text = fs.readFileSync(path.join(root, rel), "utf8");
      assert.ok(!/GSTIN/i.test(text));
      assert.ok(!/\+91\s?\d{10}/.test(text));
    }
  });

  it("getPublicSupportEmail ignores empty values and does not invent an address", () => {
    const prev = process.env.SUPPORT_EMAIL;
    delete process.env.SUPPORT_EMAIL;
    delete process.env.NEXT_PUBLIC_SUPPORT_EMAIL;
    delete process.env.LEAD_NOTIFY_EMAIL;
    assert.equal(getPublicSupportEmail(), null);
    process.env.SUPPORT_EMAIL = "support@example.com";
    assert.equal(getPublicSupportEmail(), "support@example.com");
    if (prev == null) delete process.env.SUPPORT_EMAIL;
    else process.env.SUPPORT_EMAIL = prev;
  });

  it("has an effective date", () => {
    assert.match(LEGAL_EFFECTIVE_DATE, /2026/);
  });

  it("does not name Razorpay or ₹1,499 as the current billing processor/price", () => {
    for (const rel of [
      "app/terms/page.js",
      "app/privacy/page.js",
      "app/refund-cancellation/page.js",
      "app/contact/page.js",
    ]) {
      const text = fs.readFileSync(path.join(root, rel), "utf8");
      assert.ok(!/Razorpay/i.test(text), `${rel} still mentions Razorpay`);
      assert.ok(!text.includes("₹1,499"), `${rel} still mentions ₹1,499`);
    }
  });
});
