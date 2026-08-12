// app/api/scan/route.js
// Agenticaso — real agent-readiness scanner (Engine 1: site fetch, ₹0 cost).
// Fetches the target site server-side and scores all 4 pillars for real.
// Returns the exact shape the frontend Report component already expects.

export const runtime = "nodejs";
export const maxDuration = 30; // seconds (Vercel Pro). Keep fetches short & parallel.

const AI_BOTS = [
  "GPTBot",          // OpenAI crawl
  "OAI-SearchBot",   // ChatGPT search
  "ChatGPT-User",    // ChatGPT browsing/agent
  "ClaudeBot",       // Anthropic
  "Claude-Web",
  "PerplexityBot",   // Perplexity
  "Perplexity-User",
  "Google-Extended", // Gemini training/grounding
  "Amazonbot",
  "CCBot",           // Common Crawl (feeds many models)
];

const UA =
  "Mozilla/5.0 (compatible; AgenticasoBot/1.0; +https://agenticaso.com/bot)";

function normalizeUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (!u.hostname.includes(".")) return null;
    return u;
  } catch {
    return null;
  }
}

async function fetchText(url, ms = 7000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "*/*" },
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      text,
      headers: res.headers,
      finalUrl: res.url,
    };
  } catch (e) {
    return { ok: false, status: 0, text: "", headers: null, error: String(e) };
  } finally {
    clearTimeout(t);
  }
}

// ---- robots.txt parsing: is each AI bot allowed to crawl root? ----
function analyzeRobots(robotsText) {
  if (!robotsText) return { hasFile: false, allowed: AI_BOTS, blocked: [] };
  const lines = robotsText.split(/\r?\n/).map((l) => l.trim());
  // Build map: userAgent -> array of disallow paths
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
    // blocked if any Disallow: / (whole site)
    return rules.some((r) => r === "/" || r === "/*");
  };
  const starBlocks = blocksRoot("*");
  const blocked = [];
  const allowed = [];
  for (const bot of AI_BOTS) {
    const explicitlyBlocked = blocksRoot(bot);
    // a bot is blocked if it has its own Disallow:/ OR (* blocks root AND bot has no own group overriding)
    const hasOwnGroup = !!groups[bot.toLowerCase()];
    const isBlocked = explicitlyBlocked || (starBlocks && !hasOwnGroup);
    (isBlocked ? blocked : allowed).push(bot);
  }
  return { hasFile: true, allowed, blocked, starBlocks };
}

// ---- JSON-LD schema extraction ----
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
    if (Array.isArray(t)) t.forEach(addT); else addT(t);
    if (node.offers) details.offer = true;
    if (node.aggregateRating) details.rating = true;
    if (node["@graph"]) collect(node["@graph"]);
    for (const k in node) if (typeof node[k] === "object") collect(node[k]);
  };
  while ((m = re.exec(html))) {
    try { collect(JSON.parse(m[1].trim())); } catch { /* ignore malformed */ }
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
    } catch { /* not json */ }
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

async function scan(input) {
  const u = normalizeUrl(input);
  if (!u) return { error: "That doesn't look like a valid website URL." };
  const origin = u.origin;
  const clean = u.hostname.replace(/^www\./, "");

  const [home, robots, llms, sitemap, productsJson] = await Promise.all([
    fetchText(u.href, 8000),
    fetchText(origin + "/robots.txt", 5000),
    fetchText(origin + "/llms.txt", 5000),
    fetchText(origin + "/sitemap.xml", 5000),
    fetchText(origin + "/products.json?limit=1", 5000),
  ]);

  if (!home.ok && !home.text) {
    return { error: `Couldn't reach ${clean}. Check the URL, or the site may be blocking automated requests.` };
  }

  const html = home.text || "";
  const robotsInfo = analyzeRobots(robots.ok ? robots.text : null);
  const { details: schema } = extractSchemaTypes(html);
  const hasLlms = llms.ok && /agent|allow|company|product|http/i.test(llms.text) && llms.text.length > 20;
  const hasSitemap = sitemap.ok && /<urlset|<sitemapindex|<loc>/i.test(sitemap.text);
  const { isShopify, feedOk } = detectShopify(home, productsJson);
  const meta = metaSignals(html);
  const textLen = visibleTextLength(html);
  const jsLocked = textLen < 500 && (html.match(/<script/gi)?.length || 0) > 5;

  // ---------- PILLAR 1: FOUND ----------
  let foundScore = 40;
  const totalBots = AI_BOTS.length;
  const allowedRatio = robotsInfo.allowed.length / totalBots;
  foundScore = 30 + allowedRatio * 50; // 30..80 from bot access
  if (hasSitemap) foundScore += 12;
  if (home.ok) foundScore += 8;
  const foundOk = foundScore >= 70;
  const foundNote = robotsInfo.blocked.length
    ? `robots.txt blocks ${robotsInfo.blocked.slice(0, 3).join(", ")}${robotsInfo.blocked.length > 3 ? " +more" : ""} — those AI agents can't crawl you.`
    : hasSitemap
    ? "AI agent crawlers are allowed and a sitemap is live — agents can discover you."
    : "AI crawlers are allowed, but no sitemap found — add one so agents index everything.";

  // ---------- PILLAR 2: UNDERSTOOD ----------
  let undScore = 20;
  if (schema.product) undScore += 30;
  else if (Object.values(schema).some(Boolean)) undScore += 14; // some schema
  if (hasLlms) undScore += 22;
  if (meta.title) undScore += 8;
  if (meta.desc) undScore += 8;
  if (meta.og) undScore += 6;
  if (feedOk) undScore += 10;
  if (jsLocked) undScore -= 28; // content hidden behind JS
  const undOk = undScore >= 70;
  const undNote = jsLocked
    ? "Your content loads via JavaScript — agents often see a near-empty page. Server-render key product info."
    : !schema.product && !hasLlms
    ? "No product schema or llms.txt found — agents have to guess what you sell."
    : schema.product && hasLlms
    ? "Product schema and llms.txt present — agents read your catalog cleanly."
    : "Some structured data present — add the missing piece (product schema or llms.txt) for full clarity.";

  // ---------- PILLAR 3: RECOMMENDED ----------
  let recScore = 28;
  if (schema.rating) recScore += 26;
  if (schema.review) recScore += 16;
  if (schema.org) recScore += 16;
  if (schema.offer) recScore += 10;
  if (schema.breadcrumb) recScore += 6;
  if (meta.desc) recScore += 6;
  const recOk = recScore >= 70;
  const recNote = schema.rating || schema.review
    ? "Review/rating data is machine-readable — agents can cite your social proof when recommending you."
    : "No review or rating schema found — agents skip you for rivals whose ratings they can read.";

  // ---------- PILLAR 4: BOUGHT (part heuristic) ----------
  let buyScore = 22;
  if (isShopify) buyScore += 34; // Shopify = auto-enrolled in ACP agent checkout
  if (feedOk) buyScore += 18;    // machine-readable product feed
  if (schema.offer) buyScore += 16; // price/availability agents can act on
  if (/add.to.cart|\/cart|checkout/i.test(html)) buyScore += 10;
  const buyOk = buyScore >= 70;
  const buyNote = isShopify
    ? "Shopify store detected — you're on the ACP agent-checkout rails, and your product feed is reachable."
    : schema.offer
    ? "Offer/price data is present, but no agent-checkout (ACP/UCP) signal detected — agents can suggest, not buy."
    : "No agent-checkout readiness (ACP/UCP) or price feed detected — agents can't complete a purchase.";

  const findings = [
    pillar("discover", "🔍", "Found", "Can agents crawl & index you?", foundScore, foundOk, foundNote),
    pillar("understand", "🧩", "Understood", "Do agents understand your products?", undScore, undOk, undNote),
    pillar("recommend", "⭐", "Recommended", "Will an agent pick you over a rival?", recScore, recOk, recNote),
    pillar("transact", "🛒", "Bought", "Can an agent actually check out?", buyScore, buyOk, buyNote),
  ];

  const total = Math.round(findings.reduce((a, b) => a + b.score, 0) / findings.length);
  const gap = Math.max(3, Math.min(48, 88 - total)); // vs a strong competitor (~88)
  const revenue = Math.round(gap * 1.4); // ₹K/mo estimate, derived from the gap

  const verdict =
    total >= 80
      ? `An AI agent found ${clean}, understood your catalog, and could complete a purchase. You're ahead.`
      : total >= 60
      ? `An AI agent found ${clean} but hesitated — some products were unclear and checkout was uncertain.`
      : foundScore < 55
      ? `An AI agent struggled to even see ${clean} — it's largely invisible to AI shoppers right now.`
      : `An AI agent saw ${clean} but couldn't confidently recommend it, and gave up before buying.`;

  return { clean, total, gap, revenue, findings, verdict, isShopify };
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const result = await scan(body.url);
    const status = result.error ? 422 : 200;
    return Response.json(result, { status });
  } catch (e) {
    return Response.json({ error: "Scan failed. Please try again." }, { status: 500 });
  }
}