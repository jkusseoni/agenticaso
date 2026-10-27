import { aicreditsChat, getAicreditsConfig } from "./aicredits.js";
import { runAllProviders } from "./run-provider.js";
import { OPENAI_MODEL } from "./providers/openai.js";

const UA = "Mozilla/5.0 (compatible; AgenticasoBot/1.0; +https://agenticaso.com/bot)";

/**
 * Validate and normalize a public http(s) store URL. Rejects non-http schemes.
 * @param {string} raw
 * @returns {{ ok: true, href: string, domain: string } | { ok: false, error: string }}
 */
export function validateStoreUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return { ok: false, error: "Send a valid store URL." };
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "Send a valid store URL." };
  }
  if (!/^https?:$/i.test(u.protocol)) return { ok: false, error: "Only http(s) URLs are allowed." };
  if (u.username || u.password) return { ok: false, error: "Send a valid public store URL." };
  const host = u.hostname.replace(/^www\./, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    return { ok: false, error: "Send a valid public store URL." };
  }
  // Block obvious private/link-local hosts
  if (
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) {
    return { ok: false, error: "Send a valid public store URL." };
  }
  return { ok: true, href: `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, "") || u.origin, domain: host };
}

/**
 * @param {string} url
 */
export async function siteSignals(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": UA } });
    clearTimeout(t);
    const html = await res.text();
    const pick = (re) => (html.match(re)?.[1] || "").replace(/\s+/g, " ").trim().slice(0, 300);
    const title = pick(/<title[^>]*>([^<]+)<\/title>/i);
    const desc = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i);
    const ogTitle = pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i);
    const ogDesc = pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i);
    const h1 = pick(/<h1[^>]*>([\s\S]*?)<\/h1>/i).replace(/<[^>]+>/g, "");
    const bodyText = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1200);
    return { title, desc: desc || ogDesc, ogTitle, h1, bodyText, ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Identify brand/category from site content (uses AICredits GPT when configured).
 */
export async function identifyBrand({ domain, contentBlob, brandOverride }) {
  let info = { brand: domain.split(".")[0], category: "", whatTheySell: "", isEcommerce: true };
  if (!getAicreditsConfig().configured) {
    return { ...info, brand: brandOverride || info.brand };
  }
  try {
    const raw = await aicreditsChat(OPENAI_MODEL, [
      {
        role: "system",
        content:
          'You identify a business from its website content. Return ONLY compact JSON: {"brand":"...","category":"...","whatTheySell":"...","isEcommerce":true|false}. category = the product/service niche a shopper would search for. Base it on the ACTUAL content, not the domain spelling.',
      },
      {
        role: "user",
        content: `Domain: ${domain}\n\n${contentBlob}\n\nIdentify the brand, its category, what it sells, and whether it's an e-commerce store selling physical products to consumers.`,
      },
    ]);
    info = { ...info, ...JSON.parse(raw.replace(/```json|```/g, "").trim()) };
  } catch {
    /* keep defaults */
  }
  return { ...info, brand: brandOverride || info.brand || domain.split(".")[0] };
}

/**
 * Generate up to 5 buyer questions.
 */
export async function generateBuyerQueries({ brand, category, whatTheySell, isEcommerce }) {
  let queries = [];
  if (getAicreditsConfig().configured) {
    try {
      const raw = await aicreditsChat(OPENAI_MODEL, [
        {
          role: "system",
          content:
            "You generate realistic buyer search queries a shopper would ask an AI shopping assistant when looking to BUY in this category. Return ONLY a JSON array of 5 short query strings.",
        },
        {
          role: "user",
          content: `Brand: ${brand}\nCategory: ${category}\nWhat they sell: ${whatTheySell}\nE-commerce: ${isEcommerce}\n\nGive 5 buyer queries a real customer in THIS category would ask. If NOT a consumer store (e.g. SaaS), make queries about that actual category. JSON array only.`,
        },
      ]);
      queries = JSON.parse(raw.replace(/```json|```/g, "").trim());
    } catch {
      queries = [];
    }
  }
  if (!Array.isArray(queries) || !queries.length) {
    queries = [
      `best ${category || brand} in India`,
      `top ${category || brand} brands`,
      `where to buy ${category || brand} online`,
      `${category || brand} reviews`,
      `affordable ${category || brand}`,
    ];
  }
  return queries.filter(Boolean).map(String).slice(0, 5);
}

/**
 * Multi-AI audit for one or more buyer questions across OpenAI, Perplexity, Gemini.
 *
 * @param {object} opts
 * @param {string} opts.brandName
 * @param {string} opts.websiteUrl
 * @param {string} opts.domain
 * @param {string[]} opts.questions
 * @param {string} [opts.category]
 */
export async function runMultiAiAudit({ brandName, websiteUrl, domain, questions, category = "" }) {
  const qs = (questions || []).filter(Boolean).slice(0, 5);
  const byQuestion = [];

  for (const q of qs) {
    const results = await runAllProviders({
      brandName,
      websiteUrl,
      buyerQuestion: q,
      domain,
      category,
    });
    byQuestion.push({ query: q, providers: results });
  }

  return {
    brand: brandName,
    domain,
    category,
    websiteUrl,
    queriesRun: qs.length,
    byQuestion,
  };
}
