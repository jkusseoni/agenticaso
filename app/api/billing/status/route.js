import { getPrisma, isDatabaseConfigured, assertDb } from "@/lib/db";
import { requireClerkUser, mapDbError } from "@/lib/db/auth-gate";
import {
  cancelPaddleSubscription,
  formatPlanPriceLabel,
  PRICING,
  PLAN_IDS,
} from "@/lib/billing";

export const runtime = "nodejs";

function pricingPayload() {
  return {
    pro: {
      label: formatPlanPriceLabel(),
      currency: PRICING.currency,
      amountCents: PRICING.proMonthlyCents,
      purchasable: true,
    },
    agency: {
      purchasable: false,
      note: "Contact sales — team management coming soon.",
    },
  };
}

/**
 * GET /api/billing/status
 * Server-derived plan, usage, subscription status — no secrets.
 * Clerk email verification / login flags are not used.
 */
export async function GET() {
  try {
    const gate = await requireClerkUser({ withBilling: true });
    if (!gate.ok) return gate.response;

    return Response.json({
      billing: gate.billing || {
        plan: gate.entitlements?.planId || PLAN_IDS.FREE,
        planName: gate.entitlements?.planName || "Free",
        status: gate.entitlements?.status || "none",
        isPaid: gate.isPaid === true,
        usage: gate.usage,
      },
      pricing: pricingPayload(),
    });
  } catch (e) {
    return mapDbError(e);
  }
}

/**
 * POST /api/billing/status
 * Body: { action: "cancel" } — cancel at period end (Paddle only).
 * Historical non-Paddle rows are not entitled to Pro and cannot restore Pro.
 */
export async function POST(req) {
  try {
    const gate = await requireClerkUser({ withBilling: true });
    if (!gate.ok) return gate.response;
    if (!isDatabaseConfigured()) {
      return Response.json({ error: "Database is not configured yet." }, { status: 503 });
    }

    const body = await req.json().catch(() => ({}));
    if (body.action !== "cancel") {
      return Response.json({ error: "Unsupported action." }, { status: 422 });
    }

    const db = assertDb(getPrisma());
    const sub = gate.workspace?.subscription;
    if (!gate.isPaid || !sub?.providerSubscriptionId) {
      return Response.json({ error: "No active paid subscription to cancel." }, { status: 422 });
    }

    const provider = String(sub.provider || "").toLowerCase();
    if (provider !== "paddle") {
      return Response.json({ error: "No active Paddle subscription to cancel." }, { status: 422 });
    }

    await cancelPaddleSubscription(sub.providerSubscriptionId, { effectiveFrom: "next_billing_period" });

    await db.subscription.update({
      where: { workspaceId: gate.workspace.id },
      data: { cancelAtPeriodEnd: true },
    });

    return Response.json({
      ok: true,
      message: "Subscription will cancel at the end of the current period. Your data stays.",
      cancelAtPeriodEnd: true,
    });
  } catch (e) {
    if (e?.code === "BILLING_NOT_CONFIGURED" || e?.code === "PADDLE_ERROR" || e?.code === "PADDLE_ENV_MISMATCH") {
      return Response.json({ error: "Cancel failed." }, { status: 502 });
    }
    return mapDbError(e);
  }
}
