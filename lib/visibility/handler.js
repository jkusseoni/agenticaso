/**
 * Homepage AI-visibility check (site identify → 5 buyer queries → web + memory
 * answers → share of voice). Pro comes only from the server-side Paddle
 * subscription gate; Clerk metadata is never consulted here.
 *
 * Billing: the maximum provider cost (queries × providers) is reserved
 * atomically before any billable call. A delivered result commits only the
 * answers that actually came back; a failed, timed-out, or cancelled check
 * releases the reservation. Settlement targets the reservation's period row.
 *
 * Timing: all work after the request starts shares one deadline that stays
 * well under the route's 60s maxDuration, so settlement always gets to run.
 */
import { upgradePayload } from "../billing/entitlements.js";
import { preflightAudit } from "../billing/gates.js";
import { commitUsage, releaseUsage, reserveUsage } from "../billing/usage.js";
import { fetchPublicPage } from "./fetch-page.js";
import { normalizeVisibilityTarget } from "./target.js";

export const VISIBILITY_QUERY_COUNT = 5;
export const VISIBILITY_PROVIDER_COUNT = 2;
export const GEN_MODEL = "openai/gpt-4o-mini";
export const SEARCH_MODEL = "perplexity/sonar";
export const REASON_MODEL = "openai/gpt-4o-mini";
export const VISIBILITY_USER_AGENT = "Mozilla/5.0 (compatible; AgenticasoBot/1.0; +https://agenticaso.com/bot)";

/**
 * Milliseconds, measured from the start of the request. The route's
 * maxDuration is 60s; the remaining ~15s covers settlement and response.
 * Each step is also capped by whatever is left of totalMs.
 */
export const VISIBILITY_TIMING = Object.freeze({
  totalMs: 45_000,
  minStartMs: 20_000,
  pageMs: 6_000,
  setupMs: 8_000,
  providerMs: 20_000,
});

const HITS = new Map();

/**
 * In-memory per-instance limiter (best effort; not shared across instances).
 * @param {string} key
 * @param {number} [maxPerHour]
 */
export function memoryRateLimited(key, maxPerHour = 20) {
  const now = Date.now();
  const arr = (HITS.get(key) || []).filter((t) => now - t < 3600_000);
  arr.push(now);
  HITS.set(key, arr);
  return arr.length > maxPerHour;
}

function json(body, status = 200) {
  return Response.json(body, { status });
}

function cleanText(value, max) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function parseModelJson(raw) {
  return JSON.parse(String(raw || "").replace(/```json|```/g, "").trim());
}

function codedError(code, message) {
  const error = new Error(message);
  /** @type {any} */ (error).code = code;
  return error;
}

/**
 * One shared deadline for a check, plus an optional caller signal
 * (client disconnect). step() hands each call a signal capped by both.
 * @param {{ startedAt: number, totalMs: number, clock: () => number, parentSignal?: AbortSignal|null }} input
 */
export function createDeadline({ startedAt, totalMs, clock, parentSignal = null }) {
  const endAt = startedAt + totalMs;
  const ctrl = new AbortController();
  const remaining = () => Math.max(0, endAt - clock());
  const timer = setTimeout(() => ctrl.abort(codedError("DEADLINE", "Visibility deadline reached.")), remaining());
  const onParent = () => ctrl.abort(codedError("CANCELLED", "Visibility check cancelled."));
  if (parentSignal?.aborted) onParent();
  else parentSignal?.addEventListener?.("abort", onParent, { once: true });

  return {
    signal: ctrl.signal,
    remaining,
    cancelled: () => ctrl.signal.aborted && ctrl.signal.reason?.code === "CANCELLED",
    /**
     * Run fn(signal) with at most capMs (and never past the deadline). The
     * returned promise settles on abort even if fn ignores the signal.
     * @template T
     * @param {(signal: AbortSignal) => Promise<T>|T} fn
     * @param {number} capMs
     * @returns {Promise<T>}
     */
    step(fn, capMs) {
      if (ctrl.signal.aborted) return Promise.reject(ctrl.signal.reason);
      const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(Math.max(1, Math.min(capMs, remaining())))]);
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason || codedError("DEADLINE", "Visibility deadline reached."));
        signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve()
          .then(() => fn(signal))
          .then(
            (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
            (error) => { signal.removeEventListener("abort", onAbort); reject(error); }
          );
      });
    },
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener?.("abort", onParent);
    },
  };
}

/**
 * @param {string} html
 */
export function extractSiteSignals(html) {
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
}

function normBrand(s) {
  return String(s || "").toLowerCase().replace(/^www\./, "").replace(/\.(com|in|co|shop|store|net|org).*$/, "").trim();
}

export function mentioned(answer, brand, domain) {
  const a = String(answer || "").toLowerCase();
  const b = normBrand(brand);
  const d = String(domain || "").toLowerCase();
  if (d && a.includes(d)) return true;
  if (b && b.length >= 3 && a.includes(b)) return true;
  return false;
}

export function extractCompetitors(answer, brand) {
  const b = normBrand(brand);
  const names = new Set();
  const re = /(?:\d+\.\s*|\*\*|-\s+)([A-Z][A-Za-z0-9&'.\- ]{2,40})/g;
  let m;
  while ((m = re.exec(answer)) && names.size < 8) {
    const name = m[1].trim().replace(/\*+$/, "");
    if (name && normBrand(name) !== b) names.add(name);
  }
  return [...names].slice(0, 5);
}

/**
 * Share of voice from the answers that actually came back. A failed provider
 * call is "no answer", not "not mentioned", so it never lowers the score.
 * @param {Array<{ query: string, webOk: boolean, memOk: boolean, webMentioned: boolean, memMentioned: boolean, competitors: string[] }>} rows
 */
export function scoreVisibility(rows) {
  const n = rows.length;
  const webAnswered = rows.filter((r) => r.webOk).length;
  const memAnswered = rows.filter((r) => r.memOk).length;
  const billable = webAnswered + memAnswered;
  if (!n || !webAnswered || !memAnswered) {
    return { ok: false, reason: "provider_unavailable", billable };
  }
  const webSoV = Math.round((rows.filter((r) => r.webOk && r.webMentioned).length / webAnswered) * 100);
  const memSoV = Math.round((rows.filter((r) => r.memOk && r.memMentioned).length / memAnswered) * 100);
  const overall = Math.round(webSoV * 0.7 + memSoV * 0.3);
  return {
    ok: true,
    billable,
    webSoV,
    memSoV,
    overall,
    answers: { web: webAnswered, memory: memAnswered, expected: n },
    partial: webAnswered < n || memAnswered < n,
  };
}

/**
 * @param {{
 *   target: { url: URL, domain: string },
 *   brandOverride?: unknown,
 *   chat: (model: string, messages: object[], opts?: { web?: boolean, signal?: AbortSignal }) => Promise<string>,
 *   fetchPage: (url: URL, opts: { signal: AbortSignal, timeoutMs: number }) => Promise<{ ok: boolean, text?: string }>,
 *   deadline: ReturnType<typeof createDeadline>,
 *   timing?: typeof VISIBILITY_TIMING
 * }} input
 */
export async function runVisibilityAnalysis({ target, brandOverride, chat, fetchPage, deadline, timing = VISIBILITY_TIMING }) {
  const { url, domain } = target;
  const page = await deadline
    .step((signal) => fetchPage(url, { signal, timeoutMs: Math.min(timing.pageMs, deadline.remaining()) }), timing.pageMs)
    .catch(() => ({ ok: false }));
  if (deadline.cancelled()) return { ok: false, reason: "cancelled", billable: 0 };
  const sig = page?.ok && typeof page.text === "string" ? extractSiteSignals(page.text) : { ok: false };
  const contentBlob = sig.ok
    ? `Title: ${sig.title}\nOG Title: ${sig.ogTitle}\nDescription: ${sig.desc}\nH1: ${sig.h1}\nPage text: ${sig.bodyText}`
    : `(could not fetch site; only the domain is known: ${domain})`;

  const setupChat = (messages) => deadline.step((signal) => chat(GEN_MODEL, messages, { signal }), timing.setupMs);

  const idPrompt = [
    { role: "system", content: "You identify a business from its website content. Return ONLY compact JSON: {\"brand\":\"...\",\"category\":\"...\",\"whatTheySell\":\"...\",\"isEcommerce\":true|false}. category = the product/service niche a shopper would search for. Base it on the ACTUAL content, not the domain spelling." },
    { role: "user", content: `Domain: ${domain}\n\n${contentBlob}\n\nIdentify the brand, its category, what it sells, and whether it's an e-commerce store selling physical products to consumers.` },
  ];
  const info = { brand: domain.split(".")[0], category: "", whatTheySell: "", isEcommerce: true };
  try {
    const parsed = parseModelJson(await setupChat(idPrompt));
    if (parsed && typeof parsed === "object") {
      info.brand = cleanText(parsed.brand, 80) || info.brand;
      info.category = cleanText(parsed.category, 120);
      info.whatTheySell = cleanText(parsed.whatTheySell, 300);
      if (typeof parsed.isEcommerce === "boolean") info.isEcommerce = parsed.isEcommerce;
    }
  } catch {
    /* identification is best effort */
  }
  if (deadline.cancelled()) return { ok: false, reason: "cancelled", billable: 0 };

  const brand = cleanText(brandOverride, 80) || info.brand || domain.split(".")[0];
  const category = info.category;

  const genPrompt = [
    { role: "system", content: "You generate realistic buyer search queries a shopper would ask an AI shopping assistant when looking to BUY in this category. Return ONLY a JSON array of 5 short query strings." },
    { role: "user", content: `Brand: ${brand}\nCategory: ${category}\nWhat they sell: ${info.whatTheySell}\nE-commerce: ${info.isEcommerce}\n\nGive 5 buyer queries a real customer in THIS category would ask. If NOT a consumer store (e.g. SaaS), make queries about that actual category. JSON array only.` },
  ];
  let queries = [];
  try {
    const parsed = parseModelJson(await setupChat(genPrompt));
    if (Array.isArray(parsed)) queries = parsed.map((q) => cleanText(q, 200)).filter(Boolean);
  } catch {
    queries = [];
  }
  if (deadline.cancelled()) return { ok: false, reason: "cancelled", billable: 0 };
  if (!queries.length) {
    const topic = category || brand;
    queries = [`best ${topic} in India`, `top ${topic} brands`, `where to buy ${topic} online`, `${topic} reviews`, `affordable ${topic}`];
  }
  queries = queries.slice(0, VISIBILITY_QUERY_COUNT);

  const ask = (model, messages, opts = {}) =>
    deadline.step((signal) => chat(model, messages, { ...opts, signal }), timing.providerMs).then(
      (text) => ({ ok: typeof text === "string" && text.trim().length > 0, text: String(text || "") }),
      () => ({ ok: false, text: "" })
    );

  const rows = await Promise.all(
    queries.map(async (q) => {
      const [web, mem] = await Promise.all([
        ask(SEARCH_MODEL, [{ role: "system", content: "You are a helpful shopping assistant. Recommend specific real brands/stores with brief reasons." }, { role: "user", content: q }], { web: true }),
        ask(REASON_MODEL, [{ role: "system", content: "You are a shopping assistant. Recommend specific brands you know. Be concrete." }, { role: "user", content: q }]),
      ]);
      return {
        query: q,
        webOk: web.ok,
        memOk: mem.ok,
        webMentioned: web.ok && mentioned(web.text, brand, domain),
        memMentioned: mem.ok && mentioned(mem.text, brand, domain),
        competitors: web.ok ? extractCompetitors(web.text, brand) : [],
      };
    })
  );
  if (deadline.cancelled()) return { ok: false, reason: "cancelled", billable: 0 };

  const score = scoreVisibility(rows);
  if (!score.ok) return { ok: false, reason: score.reason, billable: score.billable };

  const compCount = {};
  rows.forEach((x) => x.competitors.forEach((c) => { compCount[c] = (compCount[c] || 0) + 1; }));
  const topCompetitors = Object.entries(compCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, hits]) => ({ name, hits }));

  const { overall, webSoV, memSoV } = score;
  const verdict =
    overall >= 60 ? `AI assistants recommend ${brand} in most buyer searches — strong agentic visibility.` :
    overall >= 25 ? `AI assistants mention ${brand} sometimes, but often pick competitors first.` :
    `AI assistants almost never recommend ${brand} — you're invisible in agentic shopping right now.`;

  return {
    ok: true,
    billable: score.billable,
    result: {
      domain,
      brand,
      category,
      whatTheySell: info.whatTheySell,
      isEcommerce: info.isEcommerce,
      overall,
      webSoV,
      memSoV,
      queriesRun: rows.length,
      verdict,
      perQuery: rows,
      topCompetitors,
      answers: score.answers,
      partial: score.partial,
    },
  };
}

function logFailure(label, error) {
  console.error(label, error?.code || "error");
}

/**
 * @param {{
 *   gate: any,
 *   body: any,
 *   deps?: {
 *     chat?: Function,
 *     configured?: boolean,
 *     fetchPage?: Function,
 *     reserve?: typeof reserveUsage,
 *     commit?: typeof commitUsage,
 *     release?: typeof releaseUsage,
 *     rateLimited?: (key: string) => boolean,
 *     now?: () => Date,
 *     clock?: () => number,
 *     startedAt?: number,
 *     signal?: AbortSignal|null,
 *     timing?: Partial<typeof VISIBILITY_TIMING>
 *   }
 * }} input
 * @returns {Promise<Response>}
 */
export async function handleVisibilityRequest({ gate, body, deps = {} }) {
  const {
    chat,
    configured = true,
    fetchPage = (url, opts = {}) => fetchPublicPage(url, { userAgent: VISIBILITY_USER_AGENT, ...opts }),
    reserve = reserveUsage,
    commit = commitUsage,
    release = releaseUsage,
    rateLimited = (key) => memoryRateLimited(key, 20),
    now = () => new Date(),
    clock = Date.now,
    signal = null,
  } = deps;
  const timing = { ...VISIBILITY_TIMING, ...(deps.timing || {}) };
  const startedAt = Number.isFinite(deps.startedAt) ? deps.startedAt : clock();

  if (!gate?.ok || !gate.userId) {
    return json({ error: "Please sign in to run an AI-visibility check." }, 401);
  }
  const entitlements = gate.entitlements;
  if (entitlements?.isPaid !== true) {
    const upgrade = upgradePayload({
      planId: entitlements?.planId,
      feature: "aiVisibility",
      message: "Upgrade to Pro to unlock AI-visibility checks.",
    });
    return json({ error: "This is a Pro feature. Upgrade to unlock AI-visibility checks.", ...upgrade }, 402);
  }
  if (!configured || typeof chat !== "function") {
    return json({ error: "Server not configured." }, 500);
  }

  const target = normalizeVisibilityTarget(body?.url);
  if (!target) return json({ error: "Send a valid store URL." }, 422);
  if (rateLimited(`${gate.userId}:${target.domain}`)) {
    return json({ error: "Rate limit hit — try later." }, 429);
  }

  const prisma = gate.prisma;
  const workspaceId = gate.workspace?.id;
  if (!prisma || !workspaceId) {
    return json({ error: "Billing is not available right now. Try again shortly." }, 503);
  }

  const pre = preflightAudit({
    entitlements,
    usage: gate.usage,
    questionCount: VISIBILITY_QUERY_COUNT,
    providerCount: VISIBILITY_PROVIDER_COUNT,
  });
  if (!pre.ok) {
    return json({ error: pre.upgrade.message, ...pre.upgrade }, 402);
  }

  const busy = () => json({ error: "The check couldn't start in time. No AI tests were charged — try again." }, 503);
  if (signal?.aborted) return json({ error: "Visibility check was cancelled." }, 503);
  if (startedAt + timing.totalMs - clock() < timing.minStartMs) return busy();

  const expected = pre.expectedAiTests;
  const limit = entitlements.entitlements?.aiTestsPerMonth;
  // Settlement reuses this instant so commit/release hit the same UsagePeriod row
  // even if the check finishes after a UTC month boundary.
  const periodAt = now();
  let reservation;
  try {
    reservation = await reserve(prisma, workspaceId, { aiTests: expected, limit }, periodAt);
  } catch (error) {
    logFailure("visibility usage reserve failed:", error);
    return json({ error: "Billing is not available right now. Try again shortly." }, 503);
  }
  if (!reservation?.ok) {
    const upgrade = upgradePayload({
      planId: entitlements.planId,
      feature: "aiTests",
      used: reservation?.used,
      limit: reservation?.limit,
      message: `This check needs ${expected} AI tests and your monthly allowance is used up. It resets next billing period.`,
    });
    return json({ error: upgrade.message, ...upgrade }, 402);
  }
  const reserved = reservation.reserved;

  const releaseReservation = async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await release(prisma, workspaceId, { reservedAiTests: reserved }, periodAt);
        return true;
      } catch (error) {
        logFailure("visibility usage release failed:", error);
      }
    }
    return false;
  };

  const commitReservation = async (actual) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await commit(prisma, workspaceId, { reservedAiTests: reserved, actualAiTests: actual }, periodAt);
        return true;
      } catch (error) {
        logFailure("visibility usage commit failed:", error);
      }
    }
    // Free the hold rather than leave it stuck for the rest of the period.
    await releaseReservation();
    return false;
  };

  if (startedAt + timing.totalMs - clock() < timing.minStartMs) {
    await releaseReservation();
    return busy();
  }

  let deadline = null;
  let outcome;
  try {
    deadline = createDeadline({ startedAt, totalMs: timing.totalMs, clock, parentSignal: signal });
    outcome = await runVisibilityAnalysis({ target, brandOverride: body?.brand, chat, fetchPage, deadline, timing });
  } catch (error) {
    logFailure("visibility error:", error);
    outcome = { ok: false, reason: "error", billable: 0 };
  } finally {
    deadline?.dispose();
  }

  if (!outcome.ok) {
    await releaseReservation();
    if (outcome.reason === "cancelled") {
      return json({ error: "Visibility check was cancelled. No AI tests were charged." }, 503);
    }
    if (outcome.reason === "error") {
      return json({ error: "Visibility check failed. Try again." }, 500);
    }
    return json({ error: "We couldn't get answers from the AI engines. No AI tests were charged — try again." }, 502);
  }

  const settled = await commitReservation(Math.min(outcome.billable, reserved));
  if (!settled) {
    // The analysis completed, but billing settlement did not. Do not report a
    // successful check until usage accounting is confirmed.
    return json({ error: "Visibility check completed, but billing settlement failed. Please contact support before retrying." }, 503);
  }
  return json(outcome.result);
}
