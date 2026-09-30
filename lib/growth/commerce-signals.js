/**
 * Deterministic commerce-signal extractors for Growth Agent (Phase 1B).
 *
 * Operates only on already-observed inputs. Does not fetch, execute JS, or call an LLM.
 * Absence of a signal on the observed page is `unknown`, not `absent`, unless a
 * mutually exclusive observation is encoded below (none of the V1 signals use absent).
 */

import { observedEvidence, sliceSnippet } from "./evidence.js";
import { extractJsonLdNodes } from "./jsonld.js";

export const SIGNAL_STATUS = Object.freeze({
  PRESENT: "present",
  ABSENT: "absent",
  UNKNOWN: "unknown",
});

export const SIGNAL_KEYS = Object.freeze([
  "subscriptions",
  "high_ticket",
  "international",
  "multiple_payments",
  "shipping_complexity",
  "repeat_purchase",
]);

const CURRENCY_SYMBOL = Object.freeze({
  USD: "$",
  GBP: "£",
  EUR: "€",
  AUD: "A$",
  CAD: "C$",
  NZD: "NZ$",
});

const SYMBOL_TO_CURRENCY = Object.freeze({
  "£": "GBP",
  "€": "EUR",
  $: "USD",
  "A$": "AUD",
  "C$": "CAD",
  "NZ$": "NZD",
});

const PAYMENT_METHODS = [
  { id: "paypal", label: "PayPal", re: /\bpaypal\b|paypalobjects\.com|paypal\.com\/sdk/i },
  { id: "klarna", label: "Klarna", re: /\bklarna\b/i },
  { id: "afterpay", label: "Afterpay", re: /\bafterpay\b/i },
  { id: "clearpay", label: "Clearpay", re: /\bclearpay\b/i },
  { id: "apple_pay", label: "Apple Pay", re: /\bapple[\s-]?pay\b/i },
  { id: "google_pay", label: "Google Pay", re: /\bgoogle[\s-]?pay\b|\bgpay\b/i },
  { id: "shop_pay", label: "Shop Pay", re: /\bshop[\s-]?pay\b/i },
  { id: "ideal", label: "iDEAL", re: /\bideal\b/i },
  { id: "card", label: "card", re: /\bvisa\b|\bmastercard\b|\bamerican express\b|\bamex\b/i },
];

/**
 * @param {object} [input]
 * @param {{ highTicketThreshold?: number, currency?: string }} [options]
 */
export function extractCommerceSignals(input = {}, options = {}) {
  if (!input || typeof input !== "object") input = {};
  if (!options || typeof options !== "object") options = {};
  const html = typeof input.html === "string" ? input.html : "";
  const finalUrl = typeof input.finalUrl === "string" ? input.finalUrl : null;
  const text = visibleText(html);
  const jsonld = extractJsonLdNodes(html);
  const ctx = { html, text, jsonld, finalUrl, input };

  return {
    signals: {
      subscriptions: signalSubscriptions(ctx),
      high_ticket: signalHighTicket(ctx, options),
      international: signalInternational(ctx),
      multiple_payments: signalMultiplePayments(ctx),
      shipping_complexity: signalShipping(ctx),
      repeat_purchase: signalRepeatPurchase(ctx),
    },
  };
}

function signalSubscriptions(ctx) {
  const evidence = [];
  const plugin = find(
    ctx,
    /\/wp-content\/plugins\/woocommerce-subscriptions\//i,
    "woocommerce_subscriptions_plugin",
    "WooCommerce Subscriptions plugin assets were referenced.",
    "path",
    0.95
  );
  if (plugin) evidence.push(plugin);

  const productType = find(
    ctx,
    /\bproduct-type-(?:variable-)?subscription\b|\bdata-product_type=["']subscription["']/i,
    "subscription_product_type",
    "A subscription product type marker was observed.",
    "html",
    0.95
  );
  if (productType) evidence.push(productType);

  const technicalCopy = findOutsideNewsletter(
    ctx,
    /\bsubscribe\s*(?:and|&)\s*save\b|\bsubscription\s+(?:product|box|plan)\b|\bbilled\s+every\b|\bdelivered\s+every\s+(?:week|month|year)\b|\bmonthly\s+(?:delivery|subscription)\b/i,
    "subscription_product_language",
    "Product subscription language was observed (not a newsletter form).",
    0.7
  );
  if (technicalCopy) evidence.push(technicalCopy);

  return finishSignal("subscriptions", evidence, {
    technical: evidence.some((e) => e.extractor !== "subscription_product_language"),
  });
}

function signalHighTicket(ctx, options) {
  const prices = collectPrices(ctx);
  const threshold = Number(options.highTicketThreshold);
  const currency = normalizeCurrency(options.currency);
  const evidence = prices.map((p) =>
    observedEvidence({
      claim:
        p.context === "schema"
          ? `Observed product price ${p.raw} (${p.currency || "unknown currency"}) in product structured data.`
          : `Observed product price ${p.raw} (${p.currency || "unknown currency"}) in product markup.`,
      sourceUrl: ctx.finalUrl,
      sourceType: p.sourceType,
      observedData: p.raw,
      confidence: p.context === "schema" ? 0.9 : p.currency ? 0.85 : 0.4,
      extractor: "observed_price",
    })
  );

  const comparable = prices.filter((p) => currency && p.currency === currency && Number.isFinite(p.amount));
  const over = Number.isFinite(threshold)
    ? comparable.filter((p) => p.amount >= threshold)
    : [];

  let status = SIGNAL_STATUS.UNKNOWN;
  if (over.length) {
    status = SIGNAL_STATUS.PRESENT;
    evidence.push(
      observedEvidence({
        claim: `At least one observed price meets the caller threshold ${threshold} ${currency}.`,
        sourceUrl: ctx.finalUrl,
        sourceType: "html",
        observedData: over.map((p) => p.raw).join("; "),
        confidence: 0.9,
        extractor: "high_ticket_threshold",
      })
    );
  }

  return {
    key: "high_ticket",
    status,
    evidence: status === SIGNAL_STATUS.PRESENT ? evidence : evidence.filter((e) => e.extractor === "observed_price").slice(0, 8),
    prices: prices.map((p) => ({ amount: p.amount, currency: p.currency, raw: p.raw })),
  };
}

function signalInternational(ctx) {
  const evidence = [];
  const shipping = find(
    ctx,
    /\binternational\s+shipping\b|\bwe\s+ship\s+worldwide\b|\bships?\s+worldwide\b|\bshipping\s+to\s+(?:the\s+)?(?:uk|us|eu|europe|united states|united kingdom)\b/i,
    "international_shipping_language",
    "International shipping language was observed.",
    "visible_text",
    0.8
  );
  if (shipping) evidence.push(shipping);

  const countrySelect = countryShippingSelect(ctx);
  if (countrySelect) evidence.push(countrySelect);

  return finishSignal("international", evidence);
}

function signalMultiplePayments(ctx) {
  const methods = [];
  const evidence = [];
  const blob = `${ctx.html}\n${ctx.text}`;
  for (const method of PAYMENT_METHODS) {
    const m = blob.match(method.re);
    if (!m) continue;
    if (method.id === "ideal") {
      const around = surrounding(blob, blob.search(method.re), m[0].length);
      if (/ideal\s+(?:for|choice)/i.test(around)) continue;
    }
    methods.push(method.id);
    const checkoutContext = hasCheckoutPaymentContext(ctx);
    evidence.push(
      observedEvidence({
        claim: checkoutContext
          ? `${method.label} was observed in payment-related page material.`
          : `${method.label} text was observed.`,
        sourceUrl: ctx.finalUrl,
        sourceType: /paypalobjects|paypal\.com\/sdk/i.test(m[0]) ? "script_src" : "visible_text",
        observedData: m[0],
        confidence: checkoutContext ? 0.8 : 0.55,
        extractor: `payment_${method.id}`,
      })
    );
  }

  const status = methods.length >= 2 ? SIGNAL_STATUS.PRESENT : SIGNAL_STATUS.UNKNOWN;
  return {
    key: "multiple_payments",
    status,
    evidence: status === SIGNAL_STATUS.PRESENT ? evidence : evidence.slice(0, 4),
    methods,
  };
}

function signalShipping(ctx) {
  const facts = [];
  const checks = [
    {
      id: "free_shipping_threshold",
      re: /free\s+(?:uk\s+)?(?:shipping|delivery)\s+(?:over|from|above)\s+[£$€]?\s*[\d,]+/i,
      fact: "free_shipping_threshold",
    },
    {
      id: "local_pickup",
      re: /\blocal\s+pickup\b|\bcollect\s+from\s+store\b/i,
      fact: "local_pickup",
    },
    {
      id: "delivery_option",
      re: /\b(?:next[\s-]?day|same[\s-]?day|overnight|express|tracked|standard|home|courier)\s+delivery\b|\bdelivery\s+(?:available|options?|times?|windows?|days?)\b/i,
      fact: "delivery",
    },
    {
      id: "shipping_zones",
      re: /\bshipping\s+zones?\b/i,
      fact: "shipping_zones",
    },
    {
      id: "calculated_shipping",
      re: /\bcalculated\s+shipping\b|\benter\s+your\s+(?:postcode|zip)\s+to\s+(?:calculate|see)\s+shipping\b/i,
      fact: "calculated_shipping",
    },
    {
      id: "temperature_restriction",
      re: /\bperishable\b|\btemperature[\s-]?controlled\b|\bkeep\s+refrigerated\b/i,
      fact: "temperature_restriction",
    },
    {
      id: "shipping_class",
      re: /\bshipping\s+class(?:es)?\b/i,
      fact: "shipping_class",
    },
    {
      id: "shipping_destination_count",
      re: /\bships?\s+to\s+\d+\s+countries\b/i,
      fact: "shipping_destinations",
    },
  ];

  for (const check of checks) {
    const hit = find(
      ctx,
      check.re,
      check.id,
      "A concrete shipping statement was observed.",
      "visible_text",
      0.65
    );
    if (hit) facts.push({ fact: check.fact, evidence: hit });
  }

  const evidence = facts.map((f) => f.evidence);
  // Complexity is a later reasoning concept. V1 only reports facts; status is
  // present only when multiple distinct shipping facts were observed.
  const status = facts.length >= 2 ? SIGNAL_STATUS.PRESENT : SIGNAL_STATUS.UNKNOWN;
  return {
    key: "shipping_complexity",
    status,
    evidence,
    facts: facts.map((f) => f.fact),
  };
}

function signalRepeatPurchase(ctx) {
  const evidence = [];
  const hit = findOutsideNewsletter(
    ctx,
    /\brefill\b|\breplenish(?:ment)?\b|\brepeat\s+delivery\b|\breorder\b|\bsubscribe\s*(?:and|&)\s*save\b/i,
    "repeat_purchase_language",
    "Refill, replenishment, or repeat-delivery language was observed.",
    0.75
  );
  if (hit) evidence.push(hit);
  return finishSignal("repeat_purchase", evidence);
}

function finishSignal(key, evidence, extra = {}) {
  const status = evidence.length ? SIGNAL_STATUS.PRESENT : SIGNAL_STATUS.UNKNOWN;
  return { key, status, evidence, ...extra };
}

function find(ctx, re, extractor, claim, sourceType, confidence) {
  const m = `${ctx.html}\n${ctx.text}`.match(re);
  if (!m) return null;
  return observedEvidence({
    claim,
    sourceUrl: ctx.finalUrl,
    sourceType,
    observedData: m[0],
    confidence,
    extractor,
  });
}

function findOutsideNewsletter(ctx, re, extractor, claim, confidence) {
  const m = ctx.text.match(re) || ctx.html.match(re);
  if (!m) return null;
  const snippet = surrounding(ctx.text || ctx.html, m.index ?? 0, m[0].length);
  if (isNewsletterContext(snippet)) return null;
  return observedEvidence({
    claim,
    sourceUrl: ctx.finalUrl,
    sourceType: "visible_text",
    observedData: sliceSnippet(snippet || m[0]),
    confidence,
    extractor,
  });
}

function isNewsletterContext(snippet) {
  return /newsletter|mailing\s+list|email\s+updates|subscribe\s+to\s+(?:our\s+)?(?:newsletter|emails?|updates)|mailchimp|mc-embedded-subscribe/i.test(
    snippet
  );
}

function countryShippingSelect(ctx) {
  const html = ctx.html;
  if (!html) return null;
  const selectRe = /<select\b[^>]*(?:name|id|class)=["'][^"']*(?:shipping[-_]?country|ship[-_]?to[-_]?country|calc_shipping_country)[^"']*["'][^>]*>[\s\S]*?<\/select>/i;
  const block = html.match(selectRe);
  if (!block) return null;
  const options = [...block[0].matchAll(/<option\b[^>]*>/gi)];
  if (options.length < 5) return null;
  return observedEvidence({
    claim: "A shipping-country selector with multiple countries was observed.",
    sourceUrl: ctx.finalUrl,
    sourceType: "html",
    observedData: sliceSnippet(block[0], 400),
    confidence: 0.85,
    extractor: "shipping_country_select",
  });
}

function collectPrices(ctx) {
  const prices = [];
  collectJsonLdPrices(ctx, prices);
  collectMarkupPrices(ctx, prices);
  return dedupePrices(prices);
}

function collectJsonLdPrices(ctx, prices) {
  for (const node of ctx.jsonld) {
    if (!isProductishJsonLd(node)) continue;
    const offers = node.offers ? (Array.isArray(node.offers) ? node.offers : [node.offers]) : [];
    if (node.price != null && (node.priceCurrency || node.price)) {
      offers.push(node);
    }
    for (const offer of offers) {
      if (!offer || typeof offer !== "object") continue;
      const amount = parseAmount(offer.price);
      const currency = normalizeCurrency(offer.priceCurrency);
      if (amount == null) continue;
      prices.push({
        amount,
        currency,
        raw: `${offer.priceCurrency || ""} ${offer.price}`.trim(),
        sourceType: "schema",
        context: "schema",
      });
    }
  }
}

function collectMarkupPrices(ctx, prices) {
  const blocks = extractProductBlocks(ctx.html);
  if (isProductDetailPage(ctx.html)) {
    const priceEls =
      ctx.html.match(
        /<(?:span|p|div|bdi)\b[^>]*class=["'][^"']*(?:woocommerce-Price-amount|\bprice\b)[^"']*["'][^>]*>[\s\S]{0,240}/gi
      ) || [];
    for (const el of priceEls) blocks.push(el);
  }
  for (const block of blocks) {
    const text = visibleText(block);
    const visible = text.matchAll(
      /(?:([£€$]|A\$|C\$|NZ\$)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s+(USD|GBP|EUR|AUD|CAD))\b/g
    );
    for (const m of visible) {
      const symbol = m[1];
      const num = m[2] || m[3];
      const code = m[4];
      const amount = parseAmount(num);
      if (amount == null) continue;
      prices.push({
        amount,
        currency: code ? normalizeCurrency(code) : SYMBOL_TO_CURRENCY[symbol] || null,
        raw: m[0],
        sourceType: "html",
        context: "product_markup",
      });
    }
  }
}

function extractProductBlocks(html) {
  if (!html) return [];
  const blocks = [];
  const re =
    /<(li|div|article|section|ul)\b[^>]*(?:data-product_id=|class=["'][^"']*(?:\bproduct\b|\btype-product\b|\bproduct-type-\w+\b|\bproduct-card\b|\bwoocommerce-product\b|\bproducts\b)[^"']*["'])[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    blocks.push(sliceElement(html, m.index, m[1]));
  }
  return blocks;
}

function sliceElement(html, startIndex, tag) {
  const closeRe = new RegExp(`</${tag}\\s*>`, "gi");
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  const max = Math.min(html.length, startIndex + 4000);
  const firstGt = html.indexOf(">", startIndex);
  if (firstGt === -1) return html.slice(startIndex, max);
  if (html[firstGt - 1] === "/") return html.slice(startIndex, firstGt + 1);
  let depth = 1;
  let pos = firstGt + 1;
  while (depth > 0 && pos < max) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;
    const nOpen = openRe.exec(html);
    const nClose = closeRe.exec(html);
    if (!nClose || nClose.index >= max) break;
    if (nOpen && nOpen.index < nClose.index && nOpen.index < max) {
      depth += 1;
      pos = nOpen.index + nOpen[0].length;
    } else {
      depth -= 1;
      pos = nClose.index + nClose[0].length;
    }
  }
  return html.slice(startIndex, Math.min(pos, max));
}

function isProductDetailPage(html) {
  return /<body\b[^>]*class=["'][^"']*(?:\bsingle-product\b|\bproduct-template\b)/i.test(html || "");
}

function isProductishJsonLd(node) {
  const raw = node?.["@type"];
  const types = (Array.isArray(raw) ? raw : [raw]).map((t) =>
    String(t || "")
      .replace(/^schema:/i, "")
      .toLowerCase()
  );
  return types.some((t) => t === "product" || t === "productgroup" || t === "offer" || t === "aggregateoffer");
}

function dedupePrices(prices) {
  const seen = new Set();
  const out = [];
  for (const p of prices) {
    const key = `${p.amount}:${p.currency || ""}:${p.raw}:${p.context}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function hasCheckoutPaymentContext(ctx) {
  const url = ctx.finalUrl || "";
  if (/\/(?:checkout|payment)(?:\/|$|\?)/i.test(url)) return true;
  if (/\b(?:woocommerce-checkout|wc_checkout_params|payment_methods|payment-method)\b/i.test(ctx.html)) {
    return true;
  }
  if (/\bat checkout\b|\bpay with\b/i.test(ctx.text)) return true;
  return false;
}

function parseAmount(raw) {
  if (raw == null) return null;
  const n = Number(String(raw).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function normalizeCurrency(value) {
  if (!value) return null;
  const s = String(value).trim().toUpperCase();
  if (CURRENCY_SYMBOL[s]) return s;
  if (SYMBOL_TO_CURRENCY[value]) return SYMBOL_TO_CURRENCY[value];
  return /^[A-Z]{3}$/.test(s) ? s : null;
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

function surrounding(text, index, length) {
  const start = Math.max(0, index - 80);
  return text.slice(start, index + length + 80);
}
