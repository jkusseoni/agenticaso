/**
 * Deterministic WooCommerce detector for Growth Agent (Phase 1A).
 *
 * Operates only on already-observed inputs. Does not fetch, crawl, or call an LLM.
 * WordPress-only and generic /shop pages are not WooCommerce evidence.
 * Missing Woo markers on a WordPress page is inconclusive, not proof of absence.
 */

import { extractTypedAssets } from "./html-assets.js";

export const WOO_STATUS = Object.freeze({
  VERIFIED: "verified",
  NOT_WOOCOMMERCE: "not_woocommerce",
  INCONCLUSIVE: "inconclusive",
});

const STRONG = "strong";
const MEDIUM = "medium";
const WEAK = "weak";

const CONFIDENCE = Object.freeze({
  [STRONG]: 0.95,
  [MEDIUM]: 0.7,
  [WEAK]: 0.3,
});

/** Independent extractors that emit WooCommerce evidence from observed data. */
const WOO_EXTRACTORS = [
  {
    id: "woocommerce_plugin_path",
    strength: STRONG,
    claim: "WooCommerce plugin assets are referenced on the site.",
    sourceType: "script_src",
    test: (ctx) =>
      firstMatch(
        ctx.assetUrls,
        /\/wp-content\/plugins\/woocommerce\//i,
        "path"
      ),
  },
  {
    id: "woocommerce_generator_meta",
    strength: STRONG,
    claim: "HTML generator meta names WooCommerce.",
    sourceType: "html",
    test: (ctx) => {
      const html = ctx.html;
      if (!html) return null;
      const re =
        /<meta\b[^>]*\bname=["']generator["'][^>]*\bcontent=["']([^"']*woocommerce[^"']*)["'][^>]*>/i;
      const reFlip =
        /<meta\b[^>]*\bcontent=["']([^"']*woocommerce[^"']*)["'][^>]*\bname=["']generator["'][^>]*>/i;
      const m = html.match(re) || html.match(reFlip);
      return m ? { observedData: m[0].slice(0, 300), sourceUrl: ctx.finalUrl } : null;
    },
  },
  {
    id: "wc_ajax",
    strength: STRONG,
    claim: "WooCommerce admin-ajax endpoint (wc-ajax) is referenced.",
    sourceType: "html",
    test: (ctx) => {
      const hit = firstMatch(ctx.corpus, /(?:\?|&|&amp;)wc-ajax=/i, "html");
      if (hit) return hit;
      return firstMatch(ctx.assetUrls, /[?&]wc-ajax=/i, "path");
    },
  },
  {
    id: "woocommerce_rest_api",
    strength: STRONG,
    claim: "A WooCommerce REST or Store API path was observed.",
    sourceType: "json_endpoint",
    test: (ctx) =>
      firstMatch(
        ctx.assetUrls,
        /\/(?:wp-json\/)?(?:wc\/(?:v[0-9]+|store)|wc-api\/)/i,
        "path"
      ),
  },
  {
    id: "woocommerce_params_js",
    strength: STRONG,
    claim: "WooCommerce localized JS globals or handles are present.",
    sourceType: "html",
    test: (ctx) => {
      const html = ctx.html;
      if (!html) return null;
      const re =
        /\b(?:woocommerce_params|wc_add_to_cart_params|wc_cart_fragments_params|wc_single_product_params|wcSettings|wc_checkout_params)\b/;
      const m = html.match(re);
      if (!m) return null;
      return { observedData: m[0], sourceUrl: ctx.finalUrl };
    },
  },
  {
    id: "woocommerce_body_class",
    strength: STRONG,
    claim: "The document body uses WooCommerce-specific CSS classes.",
    sourceType: "html",
    test: (ctx) => {
      const html = ctx.html;
      if (!html) return null;
      const body = html.match(/<body\b[^>]*>/i);
      if (!body) return null;
      const tag = body[0];
      const re =
        /\b(?:woocommerce|woocommerce-page|woocommerce-shop|woocommerce-cart|woocommerce-checkout|woocommerce-account|theme-woocommerce)\b/i;
      if (!re.test(tag)) return null;
      return { observedData: tag.slice(0, 400), sourceUrl: ctx.finalUrl };
    },
  },
  {
    id: "woocommerce_session_cookie",
    strength: STRONG,
    claim: "Set-Cookie includes a WooCommerce session or cart cookie.",
    sourceType: "http_header",
    test: (ctx) => {
      const cookies = ctx.setCookie;
      if (!cookies) return null;
      const re = /\b(?:wp_woocommerce_session_[a-z0-9]+|woocommerce_cart_hash|woocommerce_items_in_cart)\b/i;
      const m = cookies.match(re);
      if (!m) return null;
      return { observedData: m[0], sourceUrl: ctx.finalUrl };
    },
  },
  {
    id: "add_to_cart_query",
    strength: STRONG,
    claim: "A WooCommerce add-to-cart query parameter was observed.",
    sourceType: "link",
    test: (ctx) => firstMatch(ctx.assetUrls.concat(ctx.corpus), /[?&]add-to-cart=\d+/i, "link"),
  },
  {
    id: "woocommerce_asset_filename",
    strength: MEDIUM,
    claim: "A WooCommerce script or stylesheet filename was observed.",
    sourceType: "script",
    test: (ctx) => {
      const jsHit = firstMatch(
        ctx.scriptUrls,
        /(?:woocommerce(?:\.min)?\.js|wc-blocks(?:-vendors)?(?:\.min)?\.js)/i,
        "script"
      );
      if (jsHit) {
        return {
          ...jsHit,
          claim: "A script filename is a WooCommerce asset.",
        };
      }
      const cssHit = firstMatch(ctx.stylesheetUrls, /woocommerce(?:\.min)?\.css/i, "stylesheet");
      if (cssHit) {
        return {
          ...cssHit,
          claim: "A stylesheet filename is a WooCommerce asset.",
        };
      }
      return null;
    },
  },
  {
    id: "woocommerce_blocks_class",
    strength: MEDIUM,
    claim: "WooCommerce Blocks markup classes were observed.",
    sourceType: "html",
    test: (ctx) => {
      const html = ctx.html;
      if (!html) return null;
      const re = /\b(?:wp-block-woocommerce-|wc-block-)/i;
      const m = html.match(re);
      if (!m) return null;
      return { observedData: m[0], sourceUrl: ctx.finalUrl };
    },
  },
  {
    id: "powered_by_woocommerce",
    strength: MEDIUM,
    claim: "Page credits WooCommerce as the commerce platform.",
    sourceType: "html",
    test: (ctx) => {
      const html = ctx.html;
      if (!html) return null;
      const re = /powered\s+by\s+<a\b[^>]*woocommerce\.com[^>]*>\s*woocommerce/i;
      const m = html.match(re);
      if (m) return { observedData: m[0].slice(0, 300), sourceUrl: ctx.finalUrl };
      const plain = html.match(/powered\s+by\s+woocommerce/i);
      if (plain) return { observedData: plain[0], sourceUrl: ctx.finalUrl };
      return null;
    },
  },
  {
    id: "woocommerce_cart_checkout_path",
    strength: MEDIUM,
    claim: "A WooCommerce API or endpoint path was observed.",
    sourceType: "path",
    test: (ctx) =>
      firstMatch(ctx.assetUrls, /\/wc-(?:api|endpoint)\//i, "path"),
  },
];

const SHOPIFY_RE =
  /cdn\.shopify\.com|myshopify\.com|Shopify\.theme|window\.Shopify|shopify-section|powered by shopify/i;
const BIGCOMMERCE_RE = /cdn\.bc0a\.com|bigcommerce\.com|window\.BigCommerce/i;
const MAGENTO_RE = /mage\/cookies|Magento_Theme|static\/version\d+\/frontend\/|mage\/requirejs/i;

/**
 * @typedef {object} WooObservationInput
 * @property {string} [finalUrl]
 * @property {string} [html]
 * @property {Record<string, string>| { get: Function } | Array<{name?: string, value?: string}>} [headers]
 * @property {string[]} [scriptUrls]
 * @property {string[]} [stylesheetUrls]
 * @property {string[]} [linkUrls]
 * @property {string[]} [observedPaths]
 */

/**
 * Detect WooCommerce from already-observed site data.
 *
 * @param {WooObservationInput} [input]
 * @returns {{
 *   status: 'verified'|'not_woocommerce'|'inconclusive',
 *   evidence: Array<{
 *     claim: string,
 *     sourceUrl: string|null,
 *     sourceType: string,
 *     observedData: string,
 *     confidence: number,
 *     verificationStatus: 'observed',
 *     extractor: string,
 *     strength: 'strong'|'medium'|'weak'
 *   }>
 * }}
 */
export function detectWooCommerce(input = {}) {
  const ctx = buildContext(input);
  const evidence = [];

  for (const extractor of WOO_EXTRACTORS) {
    let hit = null;
    try {
      hit = extractor.test(ctx);
    } catch {
      hit = null;
    }
    if (!hit) continue;
    evidence.push(
      toEvidence({
        extractor: extractor.id,
        claim: hit.claim || extractor.claim,
        sourceType: hit.sourceType || extractor.sourceType,
        sourceUrl: hit.sourceUrl ?? ctx.finalUrl,
        observedData: String(hit.observedData || "").slice(0, 500),
        strength: extractor.strength,
      })
    );
  }

  const strong = evidence.filter((e) => e.strength === STRONG);
  const medium = evidence.filter((e) => e.strength === MEDIUM);

  if (strong.length >= 1 || medium.length >= 2) {
    return { status: WOO_STATUS.VERIFIED, evidence };
  }

  const alternate = detectAlternatePlatform(ctx);
  if (alternate) {
    return {
      status: WOO_STATUS.NOT_WOOCOMMERCE,
      evidence: [...evidence, alternate],
    };
  }

  return { status: WOO_STATUS.INCONCLUSIVE, evidence };
}

function buildContext(input) {
  const finalUrl = typeof input.finalUrl === "string" && input.finalUrl ? input.finalUrl : null;
  const html = typeof input.html === "string" ? input.html : "";
  const fromHtml = extractTypedAssets(html, finalUrl);
  const scriptUrls = unique(list(input.scriptUrls).concat(fromHtml.scriptUrls));
  const stylesheetUrls = unique(list(input.stylesheetUrls).concat(fromHtml.stylesheetUrls));
  const linkUrls = unique(list(input.linkUrls).concat(fromHtml.linkUrls));
  const observedPaths = list(input.observedPaths);
  const extra = [];
  if (finalUrl) extra.push(finalUrl);

  const assetUrls = unique(scriptUrls.concat(stylesheetUrls, linkUrls, observedPaths, extra));

  return {
    finalUrl,
    html,
    scriptUrls,
    stylesheetUrls,
    linkUrls,
    assetUrls,
    corpus: html,
    setCookie: readHeader(input.headers, "set-cookie"),
    headersBlob: flattenHeaders(input.headers),
  };
}

function firstMatch(values, re, sourceType) {
  const items = Array.isArray(values) ? values : [values];
  for (const item of items) {
    if (typeof item !== "string" || !item) continue;
    const m = item.match(re);
    if (m) {
      return {
        observedData: m[0].slice(0, 400),
        sourceUrl: /^https?:\/\//i.test(item) ? item : null,
        sourceType,
      };
    }
  }
  return null;
}

function detectAlternatePlatform(ctx) {
  const blob = `${ctx.html}\n${ctx.assetUrls.join("\n")}\n${ctx.headersBlob}`;
  if (SHOPIFY_RE.test(blob) || headerLooksShopify(ctx.headersBlob)) {
    return toEvidence({
      extractor: "alternate_shopify",
      claim: "Observed Shopify platform markers and no WooCommerce evidence.",
      sourceType: "html",
      sourceUrl: ctx.finalUrl,
      observedData: (blob.match(SHOPIFY_RE) || ["shopify"])[0],
      strength: STRONG,
    });
  }
  if (BIGCOMMERCE_RE.test(blob)) {
    return toEvidence({
      extractor: "alternate_bigcommerce",
      claim: "Observed BigCommerce platform markers and no WooCommerce evidence.",
      sourceType: "html",
      sourceUrl: ctx.finalUrl,
      observedData: (blob.match(BIGCOMMERCE_RE) || ["bigcommerce"])[0],
      strength: STRONG,
    });
  }
  if (MAGENTO_RE.test(blob)) {
    return toEvidence({
      extractor: "alternate_magento",
      claim: "Observed Magento platform markers and no WooCommerce evidence.",
      sourceType: "html",
      sourceUrl: ctx.finalUrl,
      observedData: (blob.match(MAGENTO_RE) || ["magento"])[0],
      strength: STRONG,
    });
  }
  return null;
}

function headerLooksShopify(headersBlob) {
  return /x-shopid|x-shopify-stage|powered-by:\s*shopify/i.test(headersBlob);
}

function toEvidence({ extractor, claim, sourceType, sourceUrl, observedData, strength }) {
  return {
    claim,
    sourceUrl: sourceUrl || null,
    sourceType,
    observedData: String(observedData || "").slice(0, 500),
    confidence: CONFIDENCE[strength] ?? CONFIDENCE[WEAK],
    verificationStatus: "observed",
    extractor,
    strength,
  };
}

function list(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter((v) => typeof v === "string" && v) : [];
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function readHeader(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") {
    const v = headers.get(name);
    return v == null ? "" : String(v);
  }
  if (Array.isArray(headers)) {
    return headers
      .filter((h) => h && String(h.name || "").toLowerCase() === name.toLowerCase())
      .map((h) => h.value)
      .join("\n");
  }
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return "";
  const v = headers[key];
  return Array.isArray(v) ? v.join("\n") : String(v);
}

function flattenHeaders(headers) {
  if (!headers) return "";
  if (typeof headers.get === "function") {
    const names = typeof headers.keys === "function" ? [...headers.keys()] : [];
    return names.map((n) => `${n}: ${headers.get(n)}`).join("\n");
  }
  if (Array.isArray(headers)) {
    return headers.map((h) => `${h?.name || ""}: ${h?.value || ""}`).join("\n");
  }
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join("\n");
}
