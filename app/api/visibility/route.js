// app/api/visibility/route.js
// Engine 2 — now gated by Clerk login + a `paid` flag in the user's public
// metadata (set it manually in the Clerk dashboard after a Razorpay payment).
// Everything else (site identify → 5 queries → Perplexity + GPT → SoV) is unchanged.

import { auth, clerkClient } from "@clerk/nextjs/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const BASE = process.env.AICREDITS_BASE_URL;
const KEY = process.env.AICREDITS_API_KEY;

const GEN_MODEL = "openai/gpt-4o-mini";
const SEARCH_MODEL = "perplexity/sonar";
const REASON_MODEL = "openai/gpt-4o-mini";
const UA = "Mozilla/5.0 (compatible; AgenticasoBot/1.0; +https://agenticaso.com/bot)";

const HITS = new Map();
function rateLimited(key, maxPerHour = 20) {
  const now = Date.now();
  const arr = (HITS.get(key) || []).filter((t) => now - t < 3600_000);
  arr.push(now); HITS.set(key, arr);
  return arr.length > maxPerHour;
}

async function chat(model, messages, { web = false } = {}) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model, messages, temperature: web ? 0.2 : 0.3, max_tokens: 700 }),
  });
  if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`${model} ${res.status}: ${t.slice(0, 200)}`); }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

async function siteSignals(url) {
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
    const bodyText = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
    return { title, desc: desc || ogDesc, ogTitle, h1, bodyText, ok: true };
  } catch { return { ok: false }; }
}

function normBrand(s) { return String(s || "").toLowerCase().replace(/^www\./, "").replace(/\.(com|in|co|shop|store|net|org).*$/, "").trim(); }
function mentioned(answer, brand, domain) {
  const a = answer.toLowerCase(); const b = normBrand(brand); const d = domain.toLowerCase();
  if (d && a.includes(d)) return true;
  if (b && b.length >= 3 && a.includes(b)) return true;
  return false;
}
function extractCompetitors(answer, brand) {
  const b = normBrand(brand); const names = new Set();
  const re = /(?:\d+\.\s*|\*\*|\-\s+)([A-Z][A-Za-z0-9&'.\- ]{2,40})/g; let m;
  while ((m = re.exec(answer)) && names.size < 8) { const name = m[1].trim().replace(/\*+$/, ""); if (name && normBrand(name) !== b) names.add(name); }
  return [...names].slice(0, 5);
}

export async function POST(req) {
  try {
    if (!BASE || !KEY) return Response.json({ error: "Server not configured." }, { status: 500 });

    // ---- GATE: must be logged in AND paid ----
    const { userId } = await auth();
    if (!userId) return Response.json({ error: "Please sign in to run an AI-visibility check." }, { status: 401 });
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const isPaid = user?.publicMetadata?.paid === true;
    if (!isPaid) return Response.json({ error: "This is a Pro feature. Upgrade to unlock AI-visibility checks.", upgrade: true }, { status: 402 });

    const body = await req.json().catch(() => ({}));
    const domainRaw = String(body.url || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
    const domain = domainRaw.replace(/^www\./, "");
    if (!domain.includes(".")) return Response.json({ error: "Send a valid store URL." }, { status: 422 });
    if (rateLimited(`${userId}:${domain}`, 20)) return Response.json({ error: "Rate limit hit — try later." }, { status: 429 });

    const siteUrl = /^https?:\/\//.test(body.url) ? body.url : `https://${domain}`;
    const sig = await siteSignals(siteUrl);
    const contentBlob = sig.ok
      ? `Title: ${sig.title}\nOG Title: ${sig.ogTitle}\nDescription: ${sig.desc}\nH1: ${sig.h1}\nPage text: ${sig.bodyText}`
      : `(could not fetch site; only the domain is known: ${domain})`;

    const idPrompt = [
      { role: "system", content: "You identify a business from its website content. Return ONLY compact JSON: {\"brand\":\"...\",\"category\":\"...\",\"whatTheySell\":\"...\",\"isEcommerce\":true|false}. category = the product/service niche a shopper would search for. Base it on the ACTUAL content, not the domain spelling." },
      { role: "user", content: `Domain: ${domain}\n\n${contentBlob}\n\nIdentify the brand, its category, what it sells, and whether it's an e-commerce store selling physical products to consumers.` },
    ];
    let info = { brand: domain.split(".")[0], category: "", whatTheySell: "", isEcommerce: true };
    try { const raw = await chat(GEN_MODEL, idPrompt); info = { ...info, ...JSON.parse(raw.replace(/```json|```/g, "").trim()) }; } catch {}

    const brand = body.brand || info.brand || domain.split(".")[0];
    const category = info.category || "";

    const genPrompt = [
      { role: "system", content: "You generate realistic buyer search queries a shopper would ask an AI shopping assistant when looking to BUY in this category. Return ONLY a JSON array of 5 short query strings." },
      { role: "user", content: `Brand: ${brand}\nCategory: ${category}\nWhat they sell: ${info.whatTheySell}\nE-commerce: ${info.isEcommerce}\n\nGive 5 buyer queries a real customer in THIS category would ask. If NOT a consumer store (e.g. SaaS), make queries about that actual category. JSON array only.` },
    ];
    let queries = [];
    try { const raw = await chat(GEN_MODEL, genPrompt); queries = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch { queries = [`best ${category || brand} in India`, `top ${category || brand} brands`, `where to buy ${category || brand} online`, `${category || brand} reviews`, `affordable ${category || brand}`]; }
    queries = queries.filter(Boolean).slice(0, 5);

    const perQuery = await Promise.all(
      queries.map(async (q) => {
        const [webAns, memAns] = await Promise.all([
          chat(SEARCH_MODEL, [{ role: "system", content: "You are a helpful shopping assistant. Recommend specific real brands/stores with brief reasons." }, { role: "user", content: q }], { web: true }).catch((e) => `__ERR__ ${e.message}`),
          chat(REASON_MODEL, [{ role: "system", content: "You are a shopping assistant. Recommend specific brands you know. Be concrete." }, { role: "user", content: q }]).catch((e) => `__ERR__ ${e.message}`),
        ]);
        const webHit = !webAns.startsWith("__ERR__") && mentioned(webAns, brand, domain);
        const memHit = !memAns.startsWith("__ERR__") && mentioned(memAns, brand, domain);
        return { query: q, webMentioned: webHit, memMentioned: memHit, competitors: webAns.startsWith("__ERR__") ? [] : extractCompetitors(webAns, brand) };
      })
    );

    const n = perQuery.length || 1;
    const webCount = perQuery.filter((x) => x.webMentioned).length;
    const memCount = perQuery.filter((x) => x.memMentioned).length;
    const webSoV = Math.round((webCount / n) * 100);
    const memSoV = Math.round((memCount / n) * 100);
    const overall = Math.round(webSoV * 0.7 + memSoV * 0.3);

    const compCount = {};
    perQuery.forEach((x) => x.competitors.forEach((c) => { compCount[c] = (compCount[c] || 0) + 1; }));
    const topCompetitors = Object.entries(compCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, hits]) => ({ name, hits }));

    const verdict =
      overall >= 60 ? `AI assistants recommend ${brand} in most buyer searches — strong agentic visibility.` :
      overall >= 25 ? `AI assistants mention ${brand} sometimes, but often pick competitors first.` :
      `AI assistants almost never recommend ${brand} — you're invisible in agentic shopping right now.`;

    return Response.json({ domain, brand, category, whatTheySell: info.whatTheySell, isEcommerce: info.isEcommerce, overall, webSoV, memSoV, queriesRun: n, verdict, perQuery, topCompetitors });
  } catch (e) {
    console.error("visibility error:", e);
    return Response.json({ error: "Visibility check failed. Try again." }, { status: 500 });
  }
}
