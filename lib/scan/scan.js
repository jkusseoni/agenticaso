import { safeFetchText } from "./safe-fetch.js";

/**
 * Agent-readiness scanner (Engine 1). Shared by REST /api/scan and MCP scan_store.
 * Response shape for scanStore() is the existing Report contract - do not change it.
 */

export const AI_BOTS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-Web",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Amazonbot",
  "CCBot",
];

const UA = "Mozilla/5.0 (compatible; AgenticasoBot/1.0; +https://agenticaso.com/bot)";

function normalizeUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (!u.hostname.includes(".") || u.username || u.password || !["http:", "https:"].includes(u.protocol)) return null;
    return u;
  } catch {
    return null;
  }
}

async function fetchText(url, ms = 7000) {
  try {
    return await safeFetchText(url, {
      timeoutMs: ms,
      headers: { "User-Agent": UA, Accept: "*/*" },
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      text: "",
      headers: null,
      error: String(e),
    };
  }
}

function analyzeRobots(robotsText) {
  if (!robotsText) return { hasFile: false, allowed: [], blocked: [], unknown: AI_BOTS };
  const lines = robotsText.split(/\r?\n/).map((l) => l.trim());
  const groups = {};
  let current = [];
  for (const line of lines) {
    if (/^#/.test(line) || line === "") continue;
    const m = line.match(/^(user-agent|disallow|allow)\s*:\s*(.*)$/i);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const val = m[2].trim();
    if (field === "user-agent") {
      const ua = val.toLowerCase();
      if (!groups[ua]) groups[ua] = [];
      current = groups[ua];
    } else if (field === "disallow" && current) {
      current.push(val);
    }
  }
  const blocksRoot = (ua) => {
    const rules = groups[ua.toLowerCase()];
    if (!rules) return false;
    return rules.some((r) => r === "/" || r === "/*");
  };
  const starBlocks = blocksRoot("*");
  const blocked = [];
  const allowed = [];
  for (const bot of AI_BOTS) {
    const explicitlyBlocked = blocksRoot(bot);
    const hasOwnGroup = !!groups[bot.toLowerCase()];
    const isBlocked = explicitlyBlocked || (starBlocks && !hasOwnGroup);
    (isBlocked ? blocked : allowed).push(bot);
  }
  return { hasFile: true, allowed, blocked, starBlocks };
}

function extractSchemaTypes(html) {
  const types = new Set();
  const details = { product: false, offer: false, rating: false, review: false, org: false, breadcrumb: false, faq: false };
  if (!html) return { types, details };
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  const collect = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(collect);
    const t = node["@type"];
    const addT = (x) => {
      if (!x) return;
      const s = String(x);
      types.add(s);
      const low = s.toLowerCase();
      if (low.includes("product")) details.product = true;
      if (low.includes("offer")) details.offer = true;
      if (low.includes("aggregaterating") || low.includes("rating")) details.rating = true;
      if (low.includes("review")) details.review = true;
      if (low.includes("organization") || low.includes("localbusiness") || low.includes("store")) details.org = true;
      if (low.includes("breadcrumb")) details.breadcrumb = true;
      if (low.includes("faqpage") || low.includes("question")) details.faq = true;
    };
    if (Array.isArray(t)) t.forEach(addT);
    else addT(t);
    if (node.offers) details.offer = true;
    if (node.aggregateRating) details.rating = true;
    if (node["@graph"]) collect(node["@graph"]);
    for (const k in node) if (typeof node[k] === "object") collect(node[k]);
  };
  while ((m = re.exec(html))) {
    try {
      collect(JSON.parse(m[1].trim()));
    } catch {
      /* ignore malformed */
    }
  }
  return { types, details };
}

function visibleTextLength(html) {
  if (!html) return 0;
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length;
}

function detectShopify(home, productsJson) {
  const h = home?.text || "";
  const hdr = home?.headers;
  const signals =
    /cdn\.shopify\.com|myshopify\.com|Shopify\.theme|window\.Shopify|shopify-section|powered by shopify/i.test(h) ||
    (hdr && (hdr.get("x-shopid") || hdr.get("x-shopify-stage") || /shopify/i.test(hdr.get("powered-by") || "")));
  let feedOk = false;
  if (productsJson?.ok) {
    try {
      const j = JSON.parse(productsJson.text);
      feedOk = Array.isArray(j.products);
    } catch {
      /* not json */
    }
  }
  return { isShopify: !!signals || feedOk, feedOk };
}

function metaSignals(html) {
  if (!html) return { title: false, desc: false, og: false };
  return {
    title: /<title[^>]*>[^<]{3,}<\/title>/i.test(html),
    desc: /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{10,}/i.test(html),
    og: /<meta[^>]+property=["']og:(title|description|image)["']/i.test(html),
  };
}

function pillar(key, i, t, q, score, ok, note) {
  return { key, i, t, q, score: Math.max(2, Math.min(98, Math.round(score))), ok, note };
}

/**
 * Full Engine-1 scan. REST `/api/scan` depends on this exact return shape.
 * @param {string} input
 */
export async function scanStore(input, { fetchFn = fetchText } = {}) {
  const u = normalizeUrl(input);
  if (!u) return { error: "That doesn't look like a valid website URL." };
  if (u.port && !["80", "443"].includes(u.port)) return { error: "Only standard web ports are supported." };
  const origin = u.origin;
  const clean = u.hostname.replace(/^www\./, "");

  const [home, robots, llms, sitemap, productsJson] = await Promise.all([
    fetchFn(u.href, 8000),
    fetchFn(origin + "/robots.txt", 5000),
    fetchFn(origin + "/llms.txt", 5000),
    fetchFn(origin + "/sitemap.xml", 5000),
    fetchFn(origin + "/products.json?limit=1", 5000),
  ]);

  if (!home.ok && !home.text) {
    return { error: `Couldn't reach ${clean}. Check the URL, or the site may be blocking automated requests.` };
  }

  const html = home.text || "";
  const robotsInfo = analyzeRobots(robots.ok ? robots.text : null);
  const evidence = {
    scannedUrl: u.href,
    checkedAt: new Date().toISOString(),
    checks: {
      homepage: { url: u.href, status: home.status, reachable: home.ok },
      robots: { url: origin + "/robots.txt", status: robots.status, available: robots.ok, blockedBots: robotsInfo.blocked },
      sitemap: { url: origin + "/sitemap.xml", status: sitemap.status, available: sitemap.ok },
      llms: { url: origin + "/llms.txt", status: llms.status, available: llms.ok },
      productFeed: { url: origin + "/products.json?limit=1", status: productsJson.status, available: productsJson.ok },
    },
  };
  const { details: schema } = extractSchemaTypes(html);
  const hasLlms = llms.ok && /agent|allow|company|product|http/i.test(llms.text) && llms.text.length > 20;
  const hasSitemap = sitemap.ok && /<urlset|<sitemapindex|<loc>/i.test(sitemap.text);
  const { isShopify, feedOk } = detectShopify(home, productsJson);
  const meta = metaSignals(html);
  const textLen = visibleTextLength(html);
  const jsLocked = textLen < 500 && (html.match(/<script/gi)?.length || 0) > 5;

  let foundScore = 40;
  const totalBots = AI_BOTS.length;
  const allowedRatio = robotsInfo.hasFile ? robotsInfo.allowed.length / totalBots : 0;
  foundScore = 30 + allowedRatio * 50;
  if (hasSitemap) foundScore += 12;
  if (home.ok) foundScore += 8;
  const foundOk = foundScore >= 70;
  const foundNote = !robots.ok
    ? "robots.txt could not be verified; crawler permissions are unknown."
    : robotsInfo.blocked.length
    ? `robots.txt blocks ${robotsInfo.blocked.slice(0, 3).join(", ")}${robotsInfo.blocked.length > 3 ? " +more" : ""} â€” those AI agents can't crawl you.`
    : hasSitemap
      ? "robots.txt root rules and sitemap were detected; actual AI indexing was not tested."
      : "No sitemap was verified. Review crawler rules and publish a sitemap for discovery.";

  let undScore = 20;
  if (schema.product) undScore += 30;
  else if (Object.values(schema).some(Boolean)) undScore += 14;
  if (hasLlms) undScore += 22;
  if (meta.title) undScore += 8;
  if (meta.desc) undScore += 8;
  if (meta.og) undScore += 6;
  if (feedOk) undScore += 10;
  if (jsLocked) undScore -= 28;
  const undOk = undScore >= 70;
  const undNote = jsLocked
    ? "Your content loads via JavaScript â€” agents often see a near-empty page. Server-render key product info."
    : !schema.product && !hasLlms
      ? "Product schema was not detected on this page; product pages were not inspected."
      : schema.product && hasLlms
        ? "Product schema and llms.txt were detected on this page; catalog-wide coverage is unverified."
        : "Some structured data present â€” add the missing piece (product schema or llms.txt) for full clarity.";

  let recScore = 28;
  if (schema.rating) recScore += 26;
  if (schema.review) recScore += 16;
  if (schema.org) recScore += 16;
  if (schema.offer) recScore += 10;
  if (schema.breadcrumb) recScore += 6;
  if (meta.desc) recScore += 6;
  const recOk = recScore >= 70;
  const recNote =
    schema.rating || schema.review
      ? "Review/rating markup detected on this page; accuracy and AI use were not verified."
      : "Review/rating markup was not detected on this page; no recommendation behavior was tested.";

  let buyScore = 22;
  if (isShopify) buyScore += 8; // platform detection alone does not prove agent checkout
  if (feedOk) buyScore += 18;
  if (schema.offer) buyScore += 16;
  if (/add.to.cart|\/cart|checkout/i.test(html)) buyScore += 10;
  const buyOk = buyScore >= 70;
  const buyNote = schema.offer
    ? "Price/offer markup detected. Agent checkout was not tested; verify purchase flow separately."
    : "Price/offer markup not detected on the scanned page. Agent checkout was not tested.";

  const findings = [
    pillar("discover", "ðŸ”", "Found", "Are basic crawler/discovery signals present?", foundScore, foundOk, foundNote),
    pillar("understand", "ðŸ§©", "Understood", "Are product information signals present?", undScore, undOk, undNote),
    pillar("recommend", "â­", "Recommended", "Are recommendation-supporting signals present?", recScore, recOk, recNote),
    pillar("transact", "ðŸ›’", "Bought", "Can an agent actually check out?", buyScore, buyOk, buyNote),
  ];

  const total = Math.round(findings.reduce((a, b) => a + b.score, 0) / findings.length);
  const issues = [
    !robots.ok && { id: "robots_unverified", pillar: "Found", severity: "medium", problem: "robots.txt could not be verified", evidence: evidence.checks.robots, fix: "Check robots.txt response and confirm crawler rules manually." },
    robotsInfo.blocked.length > 0 && { id: "bots_blocked", pillar: "Found", severity: "high", problem: "AI crawler access restricted", evidence: evidence.checks.robots, fix: "Review robots.txt and allow only the crawlers you intend to support." },
    !hasSitemap && { id: "sitemap_missing", pillar: "Found", severity: "medium", problem: "Sitemap not verified", evidence: evidence.checks.sitemap, fix: "Publish a valid sitemap.xml and reference it in robots.txt." },
    !schema.product && { id: "product_schema_missing", pillar: "Understood", severity: "high", problem: "Product schema not detected on scanned page", evidence: { url: u.href, productSchemaDetected: false }, fix: "Add accurate Product/Offer JSON-LD on actual product pages; this homepage-only check does not measure catalog coverage." },
    !schema.offer && { id: "offer_schema_missing", pillar: "Bought", severity: "medium", problem: "Offer markup not detected on scanned page", evidence: { url: u.href, offerDetected: false }, fix: "Verify price and availability on product pages with accurate Offer markup." },
    !schema.rating && { id: "rating_schema_missing", pillar: "Recommended", severity: "low", problem: "Rating markup not detected on scanned page", evidence: { url: u.href, ratingDetected: false }, fix: "Only publish review/rating structured data when genuine eligible reviews exist." },
  ].filter(Boolean);
  const verdict = total >= 80
    ? `Technical readiness signals for ${clean} look strong in this limited scan. No AI purchase or recommendation was tested.`
    : total >= 60
      ? `Some technical readiness signals for ${clean} need attention. This scan does not test real AI recommendations or checkout.`
      : `Several technical readiness signals for ${clean} need review. This is not a live AI-agent purchase test.`;
  return { clean, total, findings, verdict, isShopify, evidence, issues, scanScope: "Homepage and selected public endpoints; no catalog-wide crawl or live AI-agent checkout test." };
}
