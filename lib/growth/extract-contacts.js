/**
 * Public business contact extraction from already-observed website material.
 *
 * Never generates addresses, names, or phones. `observed` means the value
 * appeared literally in the supplied HTML/JSON-LD/URL lists — not that SMTP
 * or mailbox verification occurred.
 */

import { observedEvidence, sliceSnippet, VERIFICATION_OBSERVED } from "./evidence.js";
import { extractJsonLdNodes } from "./jsonld.js";

export const CONTACT_KIND = Object.freeze({
  EMAIL: "email",
  CONTACT_URL: "contact_url",
  PHONE: "phone",
});

export const DOMAIN_RELATION = Object.freeze({
  SAME_DOMAIN: "same_domain",
  DIFFERENT_DOMAIN: "different_domain",
  UNKNOWN: "unknown",
});

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const BLOCKED_EMAIL_DOMAINS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "test.com",
  "localhost",
  "schema.org",
  "w3.org",
  "sentry.io",
  "email.com",
]);
const ASSET_SUFFIX = /\.(?:png|jpe?g|gif|webp|svg|js|css|woff2?|map|pdf)$/i;

/**
 * @param {{ finalUrl?: string, html?: string, linkUrls?: string[] }} [input]
 */
export function extractPublicContacts(input = {}) {
  if (!input || typeof input !== "object") input = {};
  const html = typeof input.html === "string" ? input.html : "";
  const finalUrl = typeof input.finalUrl === "string" ? input.finalUrl : null;
  const storeHost = hostOf(finalUrl);
  const contacts = [];

  collectMailto(html, finalUrl, storeHost, contacts);
  collectTel(html, finalUrl, contacts);
  collectVisibleEmails(html, finalUrl, storeHost, contacts);
  collectJsonLd(html, finalUrl, storeHost, contacts);
  collectContactUrls(html, input.linkUrls, finalUrl, storeHost, contacts);

  return { contacts: dedupe(contacts) };
}

function collectMailto(html, finalUrl, storeHost, contacts) {
  const re = /<a\b[^>]*href=["']mailto:([^"'?]+)[^"']*["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    pushEmail(contacts, decode(m[1]), finalUrl, "mailto", m[0], storeHost, "mailto_href");
  }
}

function collectTel(html, finalUrl, contacts) {
  const re = /<a\b[^>]*href=["']tel:([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    pushPhone(contacts, decode(m[1]), finalUrl, "tel", m[0], "tel_href");
  }
}

function collectVisibleEmails(html, finalUrl, storeHost, contacts) {
  const text = visibleText(html);
  let m;
  EMAIL_RE.lastIndex = 0;
  while ((m = EMAIL_RE.exec(text))) {
    pushEmail(contacts, m[0], finalUrl, "visible_text", m[0], storeHost, "visible_email");
  }
}

function collectJsonLd(html, finalUrl, storeHost, contacts) {
  for (const node of extractJsonLdNodes(html)) {
    const emails = [].concat(node.email || []);
    for (const email of emails) {
      if (typeof email === "string") {
        pushEmail(contacts, email, finalUrl, "schema", email, storeHost, "jsonld_email");
      }
    }
    const phones = [].concat(node.telephone || []);
    for (const phone of phones) {
      if (typeof phone === "string") {
        pushPhone(contacts, phone, finalUrl, "schema", phone, "jsonld_phone");
      }
    }
    const urls = [].concat(node.url || [], node.contactPoint?.url || []);
    for (const url of urls) {
      if (typeof url === "string" && isContactPath(url)) {
        pushContactUrl(contacts, url, finalUrl, "schema", url, storeHost, "jsonld_contact_url");
      }
    }
  }
}

function collectContactUrls(html, extraLinks, finalUrl, storeHost, contacts) {
  const hrefs = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    hrefs.push({ href: m[1], text: stripTags(m[2]) });
  }
  for (const href of Array.isArray(extraLinks) ? extraLinks : []) {
    hrefs.push({ href, text: "" });
  }
  for (const item of hrefs) {
    if (/^mailto:/i.test(item.href) || /^tel:/i.test(item.href)) continue;
    if (isFragmentOnlyHref(item.href)) continue;
    const canonical = canonicalizeContactUrl(item.href, finalUrl);
    if (!canonical) continue;
    const contactPath = isContactPath(canonical);
    const contactLabel = isContactLabel(item.text);
    if (!contactPath && !contactLabel) continue;
    if (!contactPath && isBareHomepage(canonical)) continue;
    pushContactUrl(contacts, canonical, finalUrl, "link", item.href, storeHost, "contact_link");
  }
}

function pushEmail(contacts, raw, sourceUrl, sourceType, observedData, storeHost, extractor) {
  const email = normalizeEmail(raw);
  if (!email) return;
  contacts.push({
    kind: CONTACT_KIND.EMAIL,
    value: email,
    domainRelationship: relationForEmail(email, storeHost),
    ...contactMeta("Observed public email address.", sourceUrl, sourceType, observedData, extractor, 0.9),
  });
}

function pushPhone(contacts, raw, sourceUrl, sourceType, observedData, extractor) {
  const phone = normalizePhone(raw);
  if (!phone) return;
  contacts.push({
    kind: CONTACT_KIND.PHONE,
    value: phone,
    domainRelationship: DOMAIN_RELATION.UNKNOWN,
    ...contactMeta("Observed public telephone number.", sourceUrl, sourceType, observedData, extractor, 0.85),
  });
}

function pushContactUrl(contacts, url, sourceUrl, sourceType, observedData, storeHost, extractor) {
  const canonical = canonicalizeContactUrl(url, sourceUrl);
  if (!canonical || !/^https?:\/\//i.test(canonical)) return;
  contacts.push({
    kind: CONTACT_KIND.CONTACT_URL,
    value: canonical,
    domainRelationship: relationForHost(hostOf(canonical), storeHost),
    ...contactMeta("Observed public contact or support URL.", sourceUrl, sourceType, observedData, extractor, 0.8),
  });
}

function contactMeta(claim, sourceUrl, sourceType, observedData, extractor, confidence) {
  const evidence = observedEvidence({
    claim,
    sourceUrl,
    sourceType,
    observedData: sliceSnippet(observedData),
    confidence,
    extractor,
  });
  return {
    sourceUrl: evidence.sourceUrl,
    sourceType: evidence.sourceType,
    observedData: evidence.observedData,
    verificationStatus: VERIFICATION_OBSERVED,
    claim: evidence.claim,
    confidence: evidence.confidence,
    extractor: evidence.extractor,
  };
}

function normalizeEmail(raw) {
  let value = String(raw || "").trim().replace(/^mailto:/i, "");
  value = value.split("?")[0].replace(/^[\s<]+|[>\s]+$/g, "").toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) return null;
  if (ASSET_SUFFIX.test(value)) return null;
  const [local, domain] = value.split("@");
  if (!local || !domain) return null;
  if (BLOCKED_EMAIL_DOMAINS.has(domain)) return null;
  if (/^(?:test|user|username|email|name|your[-_]?email|noreply)$/i.test(local) && BLOCKED_EMAIL_DOMAINS.has(domain)) {
    return null;
  }
  if (/^(?:test|username|your[-_]?email)$/i.test(local)) return null;
  if (/\s/.test(value)) return null;
  return value;
}

function normalizePhone(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  const compact = value.replace(/[^\d+]/g, "");
  const digits = compact.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return value.replace(/\s+/g, " ").slice(0, 40);
}

function isContactPath(href) {
  try {
    const path = href.includes("://") ? new URL(href).pathname : String(href || "").split("#")[0].split("?")[0];
    return /\/(?:contact(?:-us)?|support|customer-service|get-in-touch|help)(?:\/|$)/i.test(path);
  } catch {
    return /\/(?:contact(?:-us)?|support|customer-service|get-in-touch|help)(?:\/|$)/i.test(String(href || ""));
  }
}

function isFragmentOnlyHref(href) {
  const value = String(href || "").trim();
  if (!value) return true;
  if (value.startsWith("#")) return true;
  try {
    const u = value.includes("://") ? new URL(value) : null;
    if (!u) return false;
    const path = u.pathname === "" ? "/" : u.pathname;
    return Boolean(u.hash) && path === "/" && !u.search;
  } catch {
    return false;
  }
}

/**
 * Strip fragments and return a navigable http(s) URL, or null.
 */
export function canonicalizeContactUrl(raw, baseUrl) {
  const value = String(raw || "").trim();
  if (!value || isFragmentOnlyHref(value)) return null;
  if (/^(?:mailto|tel|javascript|data):/i.test(value)) return null;
  let u;
  try {
    u = new URL(value, baseUrl || undefined);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  return u.href;
}

function isBareHomepage(url) {
  try {
    const u = new URL(url);
    const path = u.pathname === "" ? "/" : u.pathname;
    return path === "/" && !u.search;
  } catch {
    return false;
  }
}

function contactUrlIdentity(url) {
  try {
    const u = new URL(url);
    const path = (u.pathname.replace(/\/+$/, "") || "/").toLowerCase();
    return `contact_url:${u.protocol}//${u.hostname.toLowerCase()}${path}${u.search}`;
  } catch {
    return `contact_url:${String(url || "").toLowerCase()}`;
  }
}

function isContactLabel(text) {
  return /^(?:contact(?:\s+us)?|support|get\s+in\s+touch|customer\s+service)$/i.test(String(text || "").trim());
}

function relationForEmail(email, storeHost) {
  const domain = email.split("@")[1];
  return relationForHost(domain, storeHost);
}

function relationForHost(host, storeHost) {
  if (!host || !storeHost) return DOMAIN_RELATION.UNKNOWN;
  const a = normalizeHost(host);
  const b = normalizeHost(storeHost);
  if (!a || !b) return DOMAIN_RELATION.UNKNOWN;
  if (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) return DOMAIN_RELATION.SAME_DOMAIN;
  return DOMAIN_RELATION.DIFFERENT_DOMAIN;
}

function normalizeHost(host) {
  return String(host || "")
    .toLowerCase()
    .replace(/^www\./, "")
    .split(":")[0];
}

function hostOf(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function decode(value) {
  try {
    return decodeURIComponent(String(value || "").trim());
  } catch {
    return String(value || "").trim();
  }
}

function visibleText(html) {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(html) {
  return String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function dedupe(contacts) {
  const seen = new Set();
  const out = [];
  for (const row of contacts) {
    const key =
      row.kind === CONTACT_KIND.CONTACT_URL
        ? contactUrlIdentity(row.value)
        : `${row.kind}:${String(row.value).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
