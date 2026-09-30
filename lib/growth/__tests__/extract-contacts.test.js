import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractPublicContacts,
  CONTACT_KIND,
  DOMAIN_RELATION,
} from "../extract-contacts.js";

function values(result, kind) {
  return result.contacts.filter((c) => c.kind === kind).map((c) => c.value);
}

describe("extractPublicContacts", () => {
  it("extracts a literal mailto email", () => {
    const result = extractPublicContacts({
      finalUrl: "https://shop.example/",
      html: `<a href="mailto:hello@shop.example">Email us</a>`,
    });
    assert.deepEqual(values(result, CONTACT_KIND.EMAIL), ["hello@shop.example"]);
    assert.equal(result.contacts[0].verificationStatus, "observed");
    assert.equal(result.contacts[0].sourceType, "mailto");
    assert.equal(result.contacts[0].domainRelationship, DOMAIN_RELATION.SAME_DOMAIN);
  });

  it("extracts a visible email from page text", () => {
    const result = extractPublicContacts({
      finalUrl: "https://shop.example/contact",
      html: `<p>Write to sales@shop.example for wholesale.</p>`,
    });
    assert.ok(values(result, CONTACT_KIND.EMAIL).includes("sales@shop.example"));
  });

  it("extracts JSON-LD business email", () => {
    const result = extractPublicContacts({
      finalUrl: "https://shop.example/",
      html: `<script type="application/ld+json">
        {"@type":"Organization","email":"support@shop.example","telephone":"+44 20 7946 0958"}
      </script>`,
    });
    assert.ok(values(result, CONTACT_KIND.EMAIL).includes("support@shop.example"));
  });

  it("extracts tel: and JSON-LD phone numbers", () => {
    const result = extractPublicContacts({
      html: `<a href="tel:+442079460958">Call</a>
        <script type="application/ld+json">{"@type":"Organization","telephone":"+44 20 7946 0958"}</script>`,
    });
    const phones = result.contacts.filter((c) => c.kind === CONTACT_KIND.PHONE);
    assert.ok(phones.length >= 1);
    assert.ok(phones.every((c) => c.verificationStatus === "observed"));
  });

  it("extracts a contact page URL", () => {
    const result = extractPublicContacts({
      finalUrl: "https://shop.example/",
      html: `<a href="/contact-us">Contact us</a>`,
    });
    assert.ok(values(result, CONTACT_KIND.CONTACT_URL).includes("https://shop.example/contact-us"));
  });

  it("does not generate an email from a founder name", () => {
    const result = extractPublicContacts({
      finalUrl: "https://example.com",
      html: `<p>Jane Doe, Founder. example.com</p>`,
    });
    assert.deepEqual(values(result, CONTACT_KIND.EMAIL), []);
    assert.equal(JSON.stringify(result).includes("jane@"), false);
    assert.equal(JSON.stringify(result).includes("jane.doe@"), false);
  });

  it("does not invent info@ unless it appears in the source", () => {
    const absent = extractPublicContacts({
      finalUrl: "https://shop.example/",
      html: `<p>Email the team from the contact form.</p>`,
    });
    assert.equal(values(absent, CONTACT_KIND.EMAIL).includes("info@shop.example"), false);

    const present = extractPublicContacts({
      html: `<p>info@shop.example</p>`,
    });
    assert.ok(values(present, CONTACT_KIND.EMAIL).includes("info@shop.example"));
  });

  it("deduplicates the same email from mailto and visible text", () => {
    const result = extractPublicContacts({
      html: `<a href="mailto:hello@shop.example">hello@shop.example</a>`,
    });
    assert.equal(values(result, CONTACT_KIND.EMAIL).length, 1);
  });

  it("rejects malformed, example, and filename artifacts", () => {
    const result = extractPublicContacts({
      html: `<p>not-an-email @shop user@example.com test@test.com photo.jpg username@site
        <img alt="icon@2x.png"></p>`,
    });
    assert.deepEqual(values(result, CONTACT_KIND.EMAIL), []);
  });

  it("classifies a different-domain contact instead of treating it as same-domain", () => {
    const result = extractPublicContacts({
      finalUrl: "https://brand.example/",
      html: `<a href="mailto:help@parent-company.com">Parent support</a>`,
    });
    const row = result.contacts.find((c) => c.kind === CONTACT_KIND.EMAIL);
    assert.equal(row.value, "help@parent-company.com");
    assert.equal(row.domainRelationship, DOMAIN_RELATION.DIFFERENT_DOMAIN);
  });

  it("does not crash on missing or malformed input", () => {
    assert.deepEqual(extractPublicContacts(null).contacts, []);
    assert.deepEqual(extractPublicContacts(undefined).contacts, []);
    assert.deepEqual(extractPublicContacts("x").contacts, []);
  });

  it("accepts /contact/ and collapses hash variants to one URL", () => {
    const result = extractPublicContacts({
      finalUrl: "https://coraandspink.com/",
      html: `
        <a href="/contact/">Contact</a>
        <a href="/contact/#">Contact</a>
        <a href="/contact/#foo">Contact</a>
        <a href="/contact/#ajax-content-wrap">Contact</a>
      `,
    });
    const urls = values(result, CONTACT_KIND.CONTACT_URL);
    assert.deepEqual(urls, ["https://coraandspink.com/contact/"]);
  });

  it("rejects fragment-only theme UI hashes as contacts", () => {
    const result = extractPublicContacts({
      finalUrl: "https://coraandspink.com/",
      html: `
        <a href="#searchbox">Contact</a>
        <a href="#ajax-content-wrap">Contact</a>
        <a href="#slide-out-widget-area">Contact us</a>
        <a href="https://coraandspink.com/#searchbox">Contact</a>
      `,
    });
    assert.deepEqual(values(result, CONTACT_KIND.CONTACT_URL), []);
  });

  it("keeps distinct contact pages and literal mailto emails", () => {
    const result = extractPublicContacts({
      finalUrl: "https://coraandspink.com/",
      html: `
        <a href="/contact/">Contact</a>
        <a href="/support/">Support</a>
        <a href="mailto:info@coraandspink.com">Email</a>
      `,
    });
    const urls = values(result, CONTACT_KIND.CONTACT_URL);
    assert.ok(urls.includes("https://coraandspink.com/contact/"));
    assert.ok(urls.includes("https://coraandspink.com/support/"));
    assert.deepEqual(values(result, CONTACT_KIND.EMAIL), ["info@coraandspink.com"]);
  });
});
