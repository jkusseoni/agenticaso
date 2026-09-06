import { auth, clerkClient } from "@clerk/nextjs/server";
import { mentioned } from "@/lib/ai/brand";
import { extractCompetitorNames } from "@/lib/ai/competitors";
import { aicreditsChat, getAicreditsConfig } from "@/lib/ai/aicredits";
import {
  validateStoreUrl,
  siteSignals,
  identifyBrand,
  generateBuyerQueries,
} from "@/lib/ai/audit";
import { OPENAI_MODEL } from "@/lib/ai/providers/openai";
import { PERPLEXITY_MODEL } from "@/lib/ai/providers/perplexity";

export const runtime = "nodejs";
export const maxDuration = 60;

const HITS = new Map();
function rateLimited(key, maxPerHour = 20) {
  const now = Date.now();
  const arr = (HITS.get(key) || []).filter((t) => now - t < 3600_000);
  arr.push(now);
  HITS.set(key, arr);
  return arr.length > maxPerHour;
}

/**
 * Legacy Engine 2 — response contract unchanged for the existing UI:
 * { domain, brand, category, whatTheySell, isEcommerce, overall, webSoV, memSoV,
 *   queriesRun, verdict, perQuery, topCompetitors }
 *
 * Internals now use the shared AICredits helpers + brand/competitor libs.
 * Per-query still uses Perplexity (web) + OpenAI (memory) only — Gemini is on /api/visibility/v2.
 */
export async function POST(req) {
  try {
    if (!getAicreditsConfig().configured) {
      return Response.json({ error: "Server not configured." }, { status: 500 });
    }

    const { userId } = await auth();
    if (!userId) {
      return Response.json({ error: "Please sign in to run an AI-visibility check." }, { status: 401 });
    }
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const email =
      user?.primaryEmailAddress?.emailAddress || user?.emailAddresses?.[0]?.emailAddress || null;

    // Legacy v1 is Pro-only. Paid requires a verified provider subscription — never Clerk paid.
    let isPaid = false;
    try {
      const { getEntitlements, loadBillingContext } = await import("@/lib/billing");
      const { getPrisma, isDatabaseConfigured, getOrCreateWorkspace } = await import("@/lib/db");
      if (isDatabaseConfigured()) {
        const prisma = getPrisma();
        if (prisma) {
          const ws = await getOrCreateWorkspace(prisma, { clerkUserId: userId, email });
          const full = await prisma.workspace.findUnique({
            where: { id: ws.id },
            include: { subscription: true },
          });
          const ctx = await loadBillingContext(prisma, full);
          isPaid = ctx.entitlements.isPaid === true;
        } else {
          isPaid = getEntitlements(null).isPaid === true;
        }
      } else {
        const { getEntitlements } = await import("@/lib/billing");
        isPaid = getEntitlements(null).isPaid === true;
      }
    } catch {
      isPaid = false;
    }

    if (!isPaid) {
      return Response.json(
        {
          error: "This is a Pro feature. Upgrade to unlock AI-visibility checks.",
          upgrade: true,
          code: "ENTITLEMENT_REQUIRED",
          suggestedPlan: "pro",
          message: "Upgrade to Pro to unlock legacy visibility checks, or use the dashboard Free limits on v2.",
        },
        { status: 402 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const validated = validateStoreUrl(body.url);
    if (!validated.ok) return Response.json({ error: validated.error }, { status: 422 });

    const { domain, href: siteUrl } = validated;
    if (rateLimited(`${userId}:${domain}`, 20)) {
      return Response.json({ error: "Rate limit hit — try later." }, { status: 429 });
    }

    const sig = await siteSignals(siteUrl);
    const contentBlob = sig.ok
      ? `Title: ${sig.title}\nOG Title: ${sig.ogTitle}\nDescription: ${sig.desc}\nH1: ${sig.h1}\nPage text: ${sig.bodyText}`
      : `(could not fetch site; only the domain is known: ${domain})`;

    const info = await identifyBrand({ domain, contentBlob, brandOverride: body.brand });
    const brand = info.brand;
    const category = info.category || "";
    const queries = await generateBuyerQueries({
      brand,
      category,
      whatTheySell: info.whatTheySell,
      isEcommerce: info.isEcommerce,
    });

    const perQuery = await Promise.all(
      queries.map(async (q) => {
        const [webAns, memAns] = await Promise.all([
          aicreditsChat(
            PERPLEXITY_MODEL,
            [
              {
                role: "system",
                content: "You are a helpful shopping assistant. Recommend specific real brands/stores with brief reasons.",
              },
              { role: "user", content: q },
            ],
            { temperature: 0.2 }
          ).catch((e) => `__ERR__ ${e.message}`),
          aicreditsChat(
            OPENAI_MODEL,
            [
              {
                role: "system",
                content: "You are a shopping assistant. Recommend specific brands you know. Be concrete.",
              },
              { role: "user", content: q },
            ]
          ).catch((e) => `__ERR__ ${e.message}`),
        ]);
        const webHit = !webAns.startsWith("__ERR__") && mentioned(webAns, brand, domain);
        const memHit = !memAns.startsWith("__ERR__") && mentioned(memAns, brand, domain);
        return {
          query: q,
          webMentioned: webHit,
          memMentioned: memHit,
          competitors: webAns.startsWith("__ERR__") ? [] : extractCompetitorNames(webAns, brand),
        };
      })
    );

    const n = perQuery.length || 1;
    const webCount = perQuery.filter((x) => x.webMentioned).length;
    const memCount = perQuery.filter((x) => x.memMentioned).length;
    const webSoV = Math.round((webCount / n) * 100);
    const memSoV = Math.round((memCount / n) * 100);
    const overall = Math.round(webSoV * 0.7 + memSoV * 0.3);

    const compCount = {};
    perQuery.forEach((x) =>
      x.competitors.forEach((c) => {
        compCount[c] = (compCount[c] || 0) + 1;
      })
    );
    const topCompetitors = Object.entries(compCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, hits]) => ({ name, hits }));

    const verdict =
      overall >= 60
        ? `AI assistants recommend ${brand} in most buyer searches — strong agentic visibility.`
        : overall >= 25
          ? `AI assistants mention ${brand} sometimes, but often pick competitors first.`
          : `AI assistants almost never recommend ${brand} — you're invisible in agentic shopping right now.`;

    return Response.json({
      domain,
      brand,
      category,
      whatTheySell: info.whatTheySell,
      isEcommerce: info.isEcommerce,
      overall,
      webSoV,
      memSoV,
      queriesRun: n,
      verdict,
      perQuery,
      topCompetitors,
    });
  } catch (e) {
    console.error("visibility error:", e);
    return Response.json({ error: "Visibility check failed. Try again." }, { status: 500 });
  }
}
