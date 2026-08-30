import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEGAL_NAV,
  getPublicSupportEmail,
  DEFAULT_PUBLIC_SUPPORT_EMAIL,
  LEGAL_EFFECTIVE_DATE,
} from "../public-config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const LEGAL_FILES = [
  "app/terms/page.js",
  "app/privacy/page.js",
  "app/refund-cancellation/page.js",
  "app/contact/page.js",
];

describe("public legal pages", () => {
  it("exposes the four required public routes in footer nav", () => {
    const hrefs = LEGAL_NAV.map((i) => i.href);
    assert.deepEqual(hrefs, ["/terms", "/privacy", "/refund-cancellation", "/contact"]);
  });

  it("has page modules for required routes", () => {
    for (const rel of LEGAL_FILES) {
      assert.ok(fs.existsSync(path.join(root, rel)), `missing ${rel}`);
    }
  });

  it("refund policy uses canonical plan price helper, not a hard-coded 499", () => {
    const text = fs.readFileSync(path.join(root, "app/refund-cancellation/page.js"), "utf8");
    assert.ok(text.includes("DEFAULT_PRO_PRICE_LABEL"));
    assert.ok(!text.includes("₹499"));
  });

  it("does not invent GSTIN, phone numbers, or postal addresses", () => {
    for (const rel of ["app/contact/page.js", "app/refund-cancellation/page.js"]) {
      const text = fs.readFileSync(path.join(root, rel), "utf8");
      assert.ok(!/GSTIN/i.test(text));
      assert.ok(!/\+91\s?\d{10}/.test(text));
      assert.ok(!/PIN\s?\d{6}/.test(text));
    }
  });

  it("publishes support@agenticaso.com and allows env override", () => {
    const prevSupport = process.env.SUPPORT_EMAIL;
    const prevPublic = process.env.NEXT_PUBLIC_SUPPORT_EMAIL;
    delete process.env.SUPPORT_EMAIL;
    delete process.env.NEXT_PUBLIC_SUPPORT_EMAIL;
    assert.equal(DEFAULT_PUBLIC_SUPPORT_EMAIL, "support@agenticaso.com");
    assert.equal(getPublicSupportEmail(), "support@agenticaso.com");

    process.env.SUPPORT_EMAIL = "support@example.com";
    assert.equal(getPublicSupportEmail(), "support@example.com");
    delete process.env.SUPPORT_EMAIL;

    if (prevSupport == null) delete process.env.SUPPORT_EMAIL;
    else process.env.SUPPORT_EMAIL = prevSupport;
    if (prevPublic == null) delete process.env.NEXT_PUBLIC_SUPPORT_EMAIL;
    else process.env.NEXT_PUBLIC_SUPPORT_EMAIL = prevPublic;

    const contact = fs.readFileSync(path.join(root, "app/contact/page.js"), "utf8");
    assert.ok(contact.includes("getPublicSupportEmail"));
    assert.ok(!contact.includes("A public support email is not published"));
  });

  it("has an effective date", () => {
    assert.match(LEGAL_EFFECTIVE_DATE, /2026/);
  });

  it("names Paddle as payment processor / Merchant of Record without storing cards", () => {
    const terms = fs.readFileSync(path.join(root, "app/terms/page.js"), "utf8");
    const privacy = fs.readFileSync(path.join(root, "app/privacy/page.js"), "utf8");
    const refund = fs.readFileSync(path.join(root, "app/refund-cancellation/page.js"), "utf8");
    assert.ok(/Paddle/.test(terms));
    assert.ok(/Merchant of Record/.test(terms));
    assert.ok(/Paddle/.test(privacy));
    assert.ok(/do not store full card numbers/i.test(privacy));
    assert.ok(/Paddle/.test(refund));
    assert.ok(/Merchant of Record/.test(refund));
    assert.ok(/cancel at period end/i.test(refund));
    assert.ok(!/we initiate it via the payment provider/i.test(refund));
  });

  it("keeps Agenticaso Pro $19 wording and no legacy billing copy", () => {
    for (const rel of LEGAL_FILES) {
      const text = fs.readFileSync(path.join(root, rel), "utf8");
      assert.ok(!/Razorpay/i.test(text), `${rel} still mentions Razorpay`);
      assert.ok(!text.includes("₹499"), `${rel} still mentions ₹499`);
      assert.ok(!text.includes("₹999"), `${rel} still mentions ₹999`);
      assert.ok(!text.includes("₹1,499"), `${rel} still mentions ₹1,499`);
      assert.ok(!/\b1499\b/.test(text), `${rel} still mentions 1499`);
      assert.ok(!/\bINR\b/.test(text), `${rel} still mentions INR`);
    }
    const terms = fs.readFileSync(path.join(root, "app/terms/page.js"), "utf8");
    const refund = fs.readFileSync(path.join(root, "app/refund-cancellation/page.js"), "utf8");
    assert.ok(terms.includes("Agenticaso Pro"));
    assert.ok(terms.includes("DEFAULT_PRO_PRICE_LABEL"));
    assert.ok(refund.includes("Agenticaso Pro"));
    assert.ok(refund.includes("DEFAULT_PRO_PRICE_LABEL"));
  });
});
