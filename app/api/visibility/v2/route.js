import { auth, clerkClient } from "@clerk/nextjs/server";
import { getPrisma, isDatabaseConfigured, getOrCreateWorkspace } from "@/lib/db";
import { loadBillingContext, getEntitlements } from "@/lib/billing";
import { rateLimited } from "@/lib/api/rate-limit";
import { validateStoreUrl } from "@/lib/ai/audit";
import { runVisibilityAuditV2 } from "@/lib/ai/visibility-v2";

export const runtime = "nodejs";
export const maxDuration = 60;

async function loadEntitlementsForUser(userId, email) {
  if (!isDatabaseConfigured()) {
    return {
      entitlements: getEntitlements(null),
      usage: { aiTests: 0, audits: 0, monitoringRuns: 0 },
      workspace: null,
      prisma: null,
    };
  }
  const prisma = getPrisma();
  if (!prisma) {
    return {
      entitlements: getEntitlements(null),
      usage: { aiTests: 0, audits: 0, monitoringRuns: 0 },
      workspace: null,
      prisma: null,
    };
  }
  const workspace = await getOrCreateWorkspace(prisma, { clerkUserId: userId, email });
  const full = await prisma.workspace.findUnique({
    where: { id: workspace.id },
    include: { subscription: true, _count: { select: { websites: true } } },
  });
  const ctx = await loadBillingContext(prisma, full);
  return { ...ctx, workspace: full, prisma };
}

/**
 * Multi-AI Audit Engine (v2) + Phase 2 intelligence + Phase 3 persistence + Phase 7 entitlements.
 * JSON contract is unchanged — orchestration lives in lib/ai/visibility-v2.js.
 */
export async function POST(req) {
  const startedAt = new Date();
  try {
    const { userId } = await auth();
    if (!userId) {
      return Response.json({ error: "Please sign in to run an AI-visibility check." }, { status: 401 });
    }
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const email =
      user?.primaryEmailAddress?.emailAddress || user?.emailAddresses?.[0]?.emailAddress || null;

    const billing = await loadEntitlementsForUser(userId, email);
    const plan = billing.entitlements;

    const body = await req.json().catch(() => ({}));
    const validated = validateStoreUrl(body.url);
    if (!validated.ok) return Response.json({ error: validated.error }, { status: 422 });
    if (rateLimited(`${userId}:v2`, 15)) {
      return Response.json({ error: "Rate limit hit — try later." }, { status: 429 });
    }

    const result = await runVisibilityAuditV2({
      url: body.url,
      brand: body.brand,
      question: body.question,
      questions: body.questions,
      commerceSignals: body.commerceSignals,
      scanSignals: body.scanSignals,
      entitlements: plan,
      usage: billing.usage,
      workspace: billing.workspace,
      prisma: billing.prisma,
      clerkUserId: userId,
      email,
      startedAt,
    });

    if (!result.ok) {
      return Response.json(result.body, { status: result.status });
    }
    return Response.json(result.payload);
  } catch (e) {
    console.error("visibility v2 error:", e);
    return Response.json({ error: "Multi-AI visibility check failed. Try again." }, { status: 500 });
  }
}
