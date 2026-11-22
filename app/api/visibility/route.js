// app/api/visibility/route.js
// Engine 2 — now gated by Clerk login + a `paid` flag in the user's public
// metadata (set it manually in the Clerk dashboard after a Razorpay payment).
// Everything else (site identify → 5 queries → Perplexity + GPT → SoV) is unchanged.

import { requireClerkUser } from "@/lib/db/auth-gate";
import { getPrisma } from "@/lib/db";
import { safeFetchText } from "@/lib/scan/safe-fetch.js";
import { aicreditsChat } from "@/lib/ai/aicredits.js";
import { budgetAuthorizationCode, openProviderScanBudget, providerBudgetStorage, readProviderBudgetConfig, rethrowBudgetAuthorizationError } from "@/lib/ai/provider-budget.js";

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
  return aicreditsChat(model, messages, { temperature: web ? 0.2 : 0.3, max_tokens: 700 });
}

async function siteSignals(url) {
  try {
    const res = await safeFetchText(url, { timeoutMs: 8000, headers: { "User-Agent": UA } });
    if (!res.ok) return { ok: false };
    const html = res.text;
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


    // ---- GATE: must be logged in AND paid ----
    const gate = await requireClerkUser({ requirePaid: true });
    if (!gate.ok) return gate.response;
    const { userId } = gate;
    const budgetConfig = readProviderBudgetConfig();
    if (!budgetConfig.ok) {
      return Response.json({ error: "provider_budget_unverified" }, { status: 503 });
    }
    if (!budgetConfig.enabled) {
      return Response.json({ error: budgetConfig.killed ? "ai_provider_kill_switch" : "ai_execution_disabled" }, { status: 503 });
    }
    const opened = await openProviderScanBudget(getPrisma(), budgetConfig);
    if (!opened.ok) {
      return Response.json({ error: opened.reason || "provider_budget_unverified" }, { status: 503 });
    }
    return await providerBudgetStorage.run(opened.state, async () => {
    if (!BASE || !KEY) return Response.json({ error: "Server not configured." }, { status: 500 });

    const body = await req.json().catch(() => ({}));
    const domainRaw = String(body.url || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
    const domain = domainRaw.replace(/^www\./, "");
    if (!domain.includes(".")) return Response.json({ error: "Send a valid store URL." }, { status: 422 });
    if (rateLimited(`${userId}:${domain}`, 20)) return Response.json({ error: "Rate limit hit — try later." }, { status: 429 });

    const siteUrl = /^https?:\/\//.test(body.url) ? body.url : `https://${domain}`;
    const sig = await siteSignals(siteUrl);
    if (!sig.ok) {
      return Response.json(
        { error: "Couldn't reach that website. Check the URL and try again." },
        { status: 422 }
      );
    }
    const contentBlob = `Title: ${sig.title}\nOG Title: ${sig.ogTitle}\nDescription: ${sig.desc}\nH1: ${sig.h1}\nPage text: ${sig.bodyText}`;

    const idPrompt = [
      { role: "system", content: "You identify a business from its website content. Return ONLY compact JSON: {\"brand\":\"...\",\"category\":\"...\",\"whatTheySell\":\"...\",\"isEcommerce\":true|false}. category = the product/service niche a shopper would search for. Base it on the ACTUAL content, not the domain spelling." },
      { role: "user", content: `Domain: ${domain}\n\n${contentBlob}\n\nIdentify the brand, its category, what it sells, and whether it's an e-commerce store selling physical products to consumers.` },
    ];
    let info = { brand: domain.split(".")[0], category: "", whatTheySell: "", isEcommerce: true };
    try { const raw = await chat(GEN_MODEL, idPrompt); info = { ...info, ...JSON.parse(raw.replace(/```json|```/g, "").trim()) }; } catch (error) { rethrowBudgetAuthorizationError(error); }

    const brand = body.brand || info.brand || domain.split(".")[0];
    const category = info.category || "";

    const genPrompt = [
      { role: "system", content: "You generate realistic buyer search queries a shopper would ask an AI shopping assistant when looking to BUY in this category. Return ONLY a JSON array of 5 short query strings." },
      { role: "user", content: `Brand: ${brand}\nCategory: ${category}\nWhat they sell: ${info.whatTheySell}\nE-commerce: ${info.isEcommerce}\n\nGive 5 buyer queries a real customer in THIS category would ask. If NOT a consumer store (e.g. SaaS), make queries about that actual category. JSON array only.` },
    ];
    let queries = [];
    try { const raw = await chat(GEN_MODEL, genPrompt); queries = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch (error) {
      rethrowBudgetAuthorizationError(error);
      queries = [`best ${category || brand} in India`, `top ${category || brand} brands`, `where to buy ${category || brand} online`, `${category || brand} reviews`, `affordable ${category || brand}`];
    }
    queries = queries.filter(Boolean).slice(0, 5);

    const perQuery = await Promise.all(
      queries.map(async (q) => {
        const [webAns, memAns] = await Promise.all([
          chat(SEARCH_MODEL, [{ role: "system", content: "You are a helpful shopping assistant. Recommend specific real brands/stores with brief reasons." }, { role: "user", content: q }], { web: true }).catch((e) => { rethrowBudgetAuthorizationError(e); return `__ERR__ ${e.message}`; }),
          chat(REASON_MODEL, [{ role: "system", content: "You are a shopping assistant. Recommend specific brands you know. Be concrete." }, { role: "user", content: q }]).catch((e) => { rethrowBudgetAuthorizationError(e); return `__ERR__ ${e.message}`; }),
        ]);
        const webOk = !webAns.startsWith("__ERR__") && Boolean(webAns.trim());
const memOk = !memAns.startsWith("__ERR__") && Boolean(memAns.trim());

const webHit = webOk ? mentioned(webAns, brand, domain) : null;
const memHit = memOk ? mentioned(memAns, brand, domain) : null;

        return {
          query: q,
          webMentioned: webHit,
          memMentioned: memHit,
          competitors: webOk ? extractCompetitors(webAns, brand) : [],
        };
      })
    );

    const n = perQuery.length;


const webValid = perQuery.filter(
  (x) => x.webMentioned !== null
);
const memValid = perQuery.filter(
  (x) => x.memMentioned !== null
);

const webCount = webValid.filter(
  (x) => x.webMentioned === true
).length;
const memCount = memValid.filter(
  (x) => x.memMentioned === true
).length;

const webSoV = webValid.length
  ? Math.round((webCount / webValid.length) * 100)
  : null;

const memSoV = memValid.length
  ? Math.round((memCount / memValid.length) * 100)
  : null;

const complete =
  n > 0 &&
  webValid.length === n &&
  memValid.length === n;

const overall = complete
  ? Math.round(webSoV * 0.7 + memSoV * 0.3)
  : null;

    const compCount = {};
    perQuery.forEach((x) => x.competitors.forEach((c) => { compCount[c] = (compCount[c] || 0) + 1; }));
    const topCompetitors = Object.entries(compCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, hits]) => ({ name, hits }));

    const verdict = !complete
  ? "AI visibility check is incomplete. Some AI requests failed. Please retry."
  : overall >= 60
    ? `In this sample, ${brand} was mentioned frequently by the tested models.`
    : overall >= 25
      ? `In this sample, ${brand} was mentioned in some AI responses.`
      : `In this sample, ${brand} was rarely mentioned by the tested models.`;

    return Response.json({ domain, brand, category, whatTheySell: info.whatTheySell, isEcommerce: info.isEcommerce, overall, webSoV, memSoV, queriesRun: n, verdict, perQuery, topCompetitors });
    });
  } catch (e) {
    const budgetCode = budgetAuthorizationCode(e);
    if (budgetCode) return Response.json({ error: budgetCode }, { status: 503 });
    console.error("visibility error:", e);
    return Response.json({ error: "Visibility check failed. Try again." }, { status: 500 });
  }
}
