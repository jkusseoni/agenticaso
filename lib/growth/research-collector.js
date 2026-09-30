/**
 * Bounded SSRF-safe storefront observation collector (Growth Phase 1C).
 *
 * Wraps lib/scan/safe-fetch.js. GET/HEAD-capable only via that implementation
 * (safe-fetch issues GET). Does not crawl sitemaps, execute JS, POST forms,
 * or score CartRenew fit.
 *
 * robots.txt: not interpreted here. scan.js's robots helper is AI-bot specific
 * (GPTBot etc.), not a general crawler policy. V1 instead refuses auth/admin
 * paths, mailto/tel, third-party hosts, and caps requests. A real robots parser
 * can be added later without changing extractor contracts.
 */

import { safeFetchText } from "../scan/safe-fetch.js";
import { detectWooCommerce } from "./woocommerce.js";
import { extractCommerceSignals } from "./commerce-signals.js";
import { extractPublicContacts } from "./extract-contacts.js";
import { extractTypedAssets } from "./html-assets.js";
import {
  MAX_ROOT_HOST_ATTEMPTS,
  classifyRootFetchFailure,
  formatRootFailureMessage,
  isEligibleForRootHostVariant,
  apexWwwVariantHref,
} from "./root-reachability.js";

export const RESEARCH_USER_AGENT = "Mozilla/5.0 (compatible; AgenticasoBot/1.0; +https://agenticaso.com/bot)";

export const RESEARCH_DEFAULTS = Object.freeze({
  maxRequests: 6,
  maxPages: 6,
  maxHtmlBytes: 150_000,
  timeoutMs: 7000,
});

/** Absolute ceiling so callers (or page content) cannot demand an unbounded crawl. */
export const RESEARCH_HARD_MAX = Object.freeze({
  maxRequests: 8,
  maxPages: 8,
  maxHtmlBytes: 500_000,
  timeoutMs: 15_000,
});

const MULTI_TLD = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "co.nz",
  "com.br",
]);

const BLOCKED_PATH =
  /\/(?:wp-admin|wp-login\.php|xmlrpc\.php|cgi-bin|administrator|admin(?:\/|$)|login|signin|sign-in|account|my-account|dashboard|cart|basket|checkout|wp-json\/(?:users))/i;

const FETCH_ROLES = new Set(["contact", "shipping", "product"]);

/**
 * Production fetch: always SSRF-safe GET via safeFetchText.
 * Tests may inject a fake with the same `(url, { timeoutMs }) => result` shape.
 */
export async function defaultResearchFetch(url, { timeoutMs = RESEARCH_DEFAULTS.timeoutMs } = {}) {
  return safeFetchText(url, {
    timeoutMs,
    headers: {
      "User-Agent": RESEARCH_USER_AGENT,
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    },
  });
}

/**
 * @param {{ url: string, limits?: object, fetchFn?: Function }} input
 */
export async function collectStoreObservations(input = {}) {
  const warnings = [];
  const usage = {
    requestsAttempted: 0,
    requestsSucceeded: 0,
    pagesCollected: 0,
    failures: 0,
  };

  const url = typeof input.url === "string" ? input.url.trim() : "";
  const limits = resolveLimits(input.limits);
  const fetchFn =
    typeof input.fetchFn === "function" ? input.fetchFn : defaultResearchFetch;

  const validated = validateCandidateUrl(url);
  if (!validated.ok) {
    return failResult(url, validated.error, usage, warnings);
  }

  const requestedUrl = validated.href;
  const rootOutcome = await fetchRootWithOptionalHostVariant({
    fetchFn,
    requestedUrl,
    registrable: validated.registrable,
    limits,
    usage,
    warnings,
  });

  if (!rootOutcome.page) {
    const failure = rootOutcome.failure;
    return {
      ok: false,
      error: formatRootFailureMessage(failure, {
        rootAttempts: rootOutcome.rootAttempts,
        variantAttempted: rootOutcome.variantAttempted,
      }),
      failure: {
        kind: failure?.kind || "OTHER_HTTP_ERROR",
        httpStatus: failure?.httpStatus ?? null,
        possibleBotBlock: Boolean(failure?.possibleBotBlock),
        rootAttempts: rootOutcome.rootAttempts,
        variantAttempted: rootOutcome.variantAttempted,
      },
      root: {
        requestedUrl,
        finalUrl: rootOutcome.finalUrl || null,
        effectiveRootUrl: null,
        variantAttempted: rootOutcome.variantAttempted,
        rootAttempts: rootOutcome.rootAttempts,
      },
      pages: [],
      observedPaths: [],
      usage,
      warnings,
      limits,
    };
  }

  const home = rootOutcome.page;
  const rootHost = registrableDomain(hostOf(home.finalUrl));
  if (!rootHost || rootHost !== validated.registrable) {
    warnings.push({
      code: "offsite_redirect",
      message: "Homepage redirected to a different registrable domain; secondary pages were not fetched.",
      url: home.finalUrl,
    });
    return {
      ok: true,
      root: { requestedUrl, finalUrl: home.finalUrl, effectiveRootUrl: null, variantAttempted: rootOutcome.variantAttempted, rootAttempts: rootOutcome.rootAttempts },
      pages: [],
      observedPaths: [],
      usage: { ...usage, pagesCollected: 0 },
      warnings,
      limits,
    };
  }

    const pages = [home];
    usage.pagesCollected += 1;
    const seen = new Set([normalizeFetchKey(home.finalUrl), normalizeFetchKey(requestedUrl)]);
  const observedPaths = new Set(pathsFrom(home));

  const discovered = discoverCandidates(home, rootHost, warnings);
  for (const path of discovered.paths) observedPaths.add(path);

  for (const candidate of discovered.fetchQueue) {
    if (usage.requestsAttempted >= limits.maxRequests) {
      warnings.push({
        code: "request_budget",
        message: `Stopped after ${limits.maxRequests} HTTP requests.`,
      });
      break;
    }
    if (pages.length >= limits.maxPages) {
      warnings.push({
        code: "page_budget",
        message: `Stopped after ${limits.maxPages} pages.`,
      });
      break;
    }
    const key = normalizeFetchKey(candidate.href);
    if (seen.has(key)) continue;
    seen.add(key);

    const secondary = await fetchPage(
      fetchFn,
      candidate.href,
      limits,
      usage,
      warnings,
      candidate.role
    );
    if (!secondary.page) continue;

    const secondaryHost = registrableDomain(hostOf(secondary.page.finalUrl));
    if (secondaryHost !== rootHost) {
      warnings.push({
        code: "offsite_redirect",
        message: "Skipped a secondary page that redirected off-site.",
        url: secondary.page.finalUrl,
      });
      continue;
    }

    pages.push(secondary.page);
    usage.pagesCollected += 1;
    for (const p of pathsFrom(secondary.page)) observedPaths.add(p);
  }

  return {
    ok: true,
    root: {
      requestedUrl,
      finalUrl: home.finalUrl,
      effectiveRootUrl: home.finalUrl,
      variantAttempted: rootOutcome.variantAttempted,
      rootAttempts: rootOutcome.rootAttempts,
    },
    pages,
    observedPaths: [...observedPaths].slice(0, 50),
    usage,
    warnings,
    limits,
  };
}

/**
 * Flatten collected pages into the observation object Phase 1A/1B extractors accept.
 */
export function toExtractorInput(collection, { highTicketThreshold, currency } = {}) {
  const pages = collection?.pages || [];
  const home = pages.find((p) => p.role === "home") || pages[0];
  const htmlParts = [];
  let truncated = false;
  for (const page of pages) {
    if (page.truncated) truncated = true;
    htmlParts.push(`<!-- growth-observed-page ${page.finalUrl} role=${page.role} truncated=${Boolean(page.truncated)} -->\n${page.html || ""}`);
  }
  return {
    finalUrl: collection?.root?.finalUrl || home?.finalUrl || null,
    html: htmlParts.join("\n"),
    headers: home?.headers || {},
    scriptUrls: pages.flatMap((p) => p.scriptUrls || []),
    stylesheetUrls: pages.flatMap((p) => p.stylesheetUrls || []),
    linkUrls: pages.flatMap((p) => p.linkUrls || []),
    observedPaths: collection?.observedPaths || [],
    truncated,
    highTicketThreshold,
    currency,
  };
}

/**
 * Run deterministic extractors on a collection. No scoring or LLM.
 */
export function analyzeCollectedObservations(collection, options = {}) {
  const input = toExtractorInput(collection, options);
  return {
    truncated: Boolean(input.truncated),
    woocommerce: detectWooCommerce(input),
    commerceSignals: extractCommerceSignals(input, options),
    contacts: extractPublicContacts(input),
  };
}

function resolveLimits(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    maxRequests: clamp(src.maxRequests, RESEARCH_DEFAULTS.maxRequests, 1, RESEARCH_HARD_MAX.maxRequests),
    maxPages: clamp(src.maxPages, RESEARCH_DEFAULTS.maxPages, 1, RESEARCH_HARD_MAX.maxPages),
    maxHtmlBytes: clamp(src.maxHtmlBytes, RESEARCH_DEFAULTS.maxHtmlBytes, 4_000, RESEARCH_HARD_MAX.maxHtmlBytes),
    timeoutMs: clamp(src.timeoutMs, RESEARCH_DEFAULTS.timeoutMs, 1_000, RESEARCH_HARD_MAX.timeoutMs),
  };
}

function clamp(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function failResult(requestedUrl, error, usage, warnings) {
  warnings.push({ code: "root_fetch_failed", message: error, url: requestedUrl || null });
  const failure = classifyRootFetchFailure({ error });
  return {
    ok: false,
    error,
    failure: {
      kind: failure.kind,
      httpStatus: failure.httpStatus,
      possibleBotBlock: false,
      rootAttempts: 0,
      variantAttempted: false,
    },
    root: { requestedUrl: requestedUrl || null, finalUrl: null, effectiveRootUrl: null, variantAttempted: false, rootAttempts: 0 },
    pages: [],
    observedPaths: [],
    usage,
    warnings,
    limits: resolveLimits({}),
  };
}

async function fetchRootWithOptionalHostVariant({ fetchFn, requestedUrl, registrable, limits, usage, warnings }) {
  const first = await fetchPage(fetchFn, requestedUrl, limits, usage, warnings, "home");
  if (first.page) {
    return { page: first.page, rootAttempts: 1, variantAttempted: false, failure: null, finalUrl: first.page.finalUrl };
  }

  const firstFailure = first.failure || classifyRootFetchFailure({ status: first.status, error: first.error, headers: first.headers, body: "" });
  const variantHref = apexWwwVariantHref(requestedUrl, registrable);
  const canRetry =
    isEligibleForRootHostVariant(firstFailure) &&
    Boolean(variantHref) &&
    usage.requestsAttempted < limits.maxRequests &&
    usage.requestsAttempted < MAX_ROOT_HOST_ATTEMPTS;

  if (!canRetry) {
    return {
      page: null,
      rootAttempts: 1,
      variantAttempted: false,
      failure: firstFailure,
      finalUrl: first.finalUrl || null,
    };
  }

  const variantOk = validateCandidateUrl(variantHref);
  if (!variantOk.ok || variantOk.registrable !== registrable) {
    return {
      page: null,
      rootAttempts: 1,
      variantAttempted: false,
      failure: firstFailure,
      finalUrl: first.finalUrl || null,
    };
  }

  warnings.push({
    code: "root_host_variant",
    message: "Retrying root on the www/apex host variant.",
    url: variantHref,
  });
  const second = await fetchPage(fetchFn, variantHref, limits, usage, warnings, "home");
  if (second.page) {
    return {
      page: second.page,
      rootAttempts: 2,
      variantAttempted: true,
      failure: null,
      finalUrl: second.page.finalUrl,
    };
  }
  const secondFailure = second.failure || classifyRootFetchFailure({ status: second.status, error: second.error, headers: second.headers, body: "" });
  if (firstFailure.possibleBotBlock && !secondFailure.possibleBotBlock) {
    secondFailure.possibleBotBlock = true;
  }
  return {
    page: null,
    rootAttempts: 2,
    variantAttempted: true,
    failure: secondFailure.httpStatus ? secondFailure : firstFailure,
    finalUrl: second.finalUrl || first.finalUrl || null,
  };
}

async function fetchPage(fetchFn, href, limits, usage, warnings, role) {
  usage.requestsAttempted += 1;
  try {
    const res = await fetchFn(href, { timeoutMs: limits.timeoutMs });
    if (!res || res.ok === false) {
      usage.failures += 1;
      const failure = classifyRootFetchFailure({
        status: res?.status,
        error: `HTTP ${res?.status || 0}`,
        headers: res?.headers,
        body: typeof res?.text === "string" ? res.text : "",
      });
      if (failure.possibleBotBlock) {
        warnings.push({
          code: "possible_bot_block",
          message: "Response metadata suggested a possible bot-protection challenge (hint only).",
          url: href,
        });
      }
      warnings.push({
        code: role === "home" ? "root_fetch_failed" : "secondary_fetch_failed",
        message: `HTTP ${res?.status || 0} for ${role} page.`,
        url: href,
      });
      return {
        page: null,
        finalUrl: res?.finalUrl || null,
        error: `HTTP ${res?.status || 0}`,
        status: res?.status || 0,
        headers: res?.headers || null,
        failure,
      };
    }
    usage.requestsSucceeded += 1;
    const rawHtml = typeof res.text === "string" ? res.text : "";
    const truncated = Buffer.byteLength(rawHtml, "utf8") > limits.maxHtmlBytes;
    const html = truncated ? truncateUtf8(rawHtml, limits.maxHtmlBytes) : rawHtml;
    const finalUrl = res.finalUrl || href;
    const assets = extractAssets(html, finalUrl);
    return {
      page: {
        role,
        requestedUrl: href,
        finalUrl,
        status: res.status || 200,
        headers: subsetHeaders(res.headers),
        html,
        truncated,
        originalBytes: Buffer.byteLength(rawHtml, "utf8"),
        scriptUrls: assets.scripts,
        stylesheetUrls: assets.styles,
        linkUrls: assets.links,
      },
    };
  } catch (e) {
    usage.failures += 1;
    const message = String(e?.message || e);
    warnings.push({
      code: role === "home" ? "root_fetch_failed" : "secondary_fetch_failed",
      message,
      url: href,
    });
    const failure = classifyRootFetchFailure({ error: message });
    return { page: null, finalUrl: null, error: message, status: null, headers: null, failure };
  }
}

function discoverCandidates(homePage, rootHost, warnings) {
  const fetchQueue = [];
  const seenRole = new Set();
  const paths = [];
  const anchors = extractAnchors(homePage.html, homePage.finalUrl);

  for (const anchor of anchors) {
    const href = anchor.href;
    if (!href) continue;
    if (/^(mailto|tel|javascript|data):/i.test(href)) {
      warnings.push({ code: "skipped_non_http", message: "Skipped mailto/tel/javascript URL.", url: href });
      continue;
    }

    let abs;
    try {
      abs = new URL(href, homePage.finalUrl);
    } catch {
      warnings.push({ code: "malformed_link", message: "Ignored a malformed href.", url: String(href).slice(0, 120) });
      continue;
    }

    if (abs.username || abs.password) continue;
    if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;

    const host = registrableDomain(abs.hostname);
    if (host !== rootHost) {
      warnings.push({ code: "skipped_external", message: "Did not follow a third-party link.", url: abs.href });
      continue;
    }

    abs.hash = "";
    const path = abs.pathname || "/";
    paths.push(path);

    if (BLOCKED_PATH.test(path)) {
      warnings.push({ code: "skipped_sensitive_path", message: "Did not fetch login, admin, cart, or checkout URLs.", url: abs.href });
      continue;
    }

    const role = classifyRole(path, anchor.text);
    if (!FETCH_ROLES.has(role)) continue;
    if (seenRole.has(role)) continue;
    seenRole.add(role);
    fetchQueue.push({ href: abs.href, role });
  }

  return { fetchQueue, paths };
}

function classifyRole(pathname, linkText) {
  const p = String(pathname || "").toLowerCase();
  const t = String(linkText || "").toLowerCase();
  if (/\/(?:contact(?:-us)?|support|customer-service|get-in-touch)(?:\/|$)/.test(p) || /^(?:contact(?: us)?|support|get in touch)$/.test(t)) {
    return "contact";
  }
  if (/\/(?:shipping|delivery|ship(?:ping)?-info)(?:\/|$)/.test(p) || /^(?:shipping|delivery)$/.test(t)) {
    return "shipping";
  }
  if (/\/(?:cart|basket)(?:\/|$)/.test(p) || /^cart$/.test(t)) return "cart";
  if (/\/checkout(?:\/|$)/.test(p) || /^checkout$/.test(t)) return "checkout";
  if (/\/(?:product|products|shop|store|catalog)(?:\/|$)/.test(p) || /^(?:shop|products|store)$/.test(t)) {
    return "product";
  }
  return "other";
}

function extractAnchors(html, baseUrl) {
  if (!html) return [];
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = (m[1].match(/\bhref=["']([^"']*)["']/i) || [])[1];
    const text = String(m[2] || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    out.push({ href: href || "", text, baseUrl });
  }
  return out;
}

function extractAssets(html, baseUrl) {
  const typed = extractTypedAssets(html, baseUrl);
  return {
    scripts: typed.scriptUrls,
    styles: typed.stylesheetUrls,
    links: typed.linkUrls,
  };
}

function subsetHeaders(headers) {
  const names = ["content-type", "set-cookie", "x-shopid", "x-shopify-stage", "powered-by"];
  const out = {};
  if (!headers) return out;
  for (const name of names) {
    let value;
    if (typeof headers.get === "function") value = headers.get(name);
    else {
      const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
      value = key ? headers[key] : null;
    }
    if (value) out[name] = String(Array.isArray(value) ? value.join(", ") : value).slice(0, 500);
  }
  return out;
}

function validateCandidateUrl(raw) {
  if (!raw) return { ok: false, error: "Send a valid storefront URL." };
  let s = raw;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "Send a valid storefront URL." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: "Only http(s) URLs are allowed." };
  }
  if (u.username || u.password) {
    return { ok: false, error: "Credentials in URLs are not allowed." };
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    !host.includes(".") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal" ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.includes(":")
  ) {
    return { ok: false, error: "Send a valid public storefront URL." };
  }
  return {
    ok: true,
    href: u.href,
    registrable: registrableDomain(host),
  };
}

function registrableDomain(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  if (!host || !host.includes(".")) return host || null;
  const labels = host.split(".");
  const last2 = labels.slice(-2).join(".");
  if (MULTI_TLD.has(last2) && labels.length >= 3) return labels.slice(-3).join(".");
  return last2;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function normalizeFetchKey(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.href;
  } catch {
    return String(url || "");
  }
}

function pathsFrom(page) {
  const out = [];
  try {
    out.push(new URL(page.finalUrl).pathname);
  } catch {
    /* ignore */
  }
  return out;
}

function absolutize(raw, baseUrl) {
  try {
    return new URL(raw, baseUrl).href;
  } catch {
    return null;
  }
}

function truncateUtf8(text, maxBytes) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8");
}
