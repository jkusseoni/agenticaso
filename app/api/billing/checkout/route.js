import { cookies } from "next/headers";
import { requireClerkUser, mapDbError } from "@/lib/db/auth-gate";
import { PLAN_IDS, formatPlanPriceLabel, PRICING } from "@/lib/billing";
import {
  createPaddleCheckoutTransaction,
  isPaddleConfigured,
  getPaddleEnvironment,
  getPaddleProPriceId,
} from "@/lib/billing/paddle.js";
import { recordTrustedCheckoutStart } from "@/lib/growth/checkout-start.js";
import { readFunnelSession } from "@/lib/growth/session.js";

export const runtime = "nodejs";

/**
 * POST /api/billing/checkout
 * Creates a Paddle overlay checkout transaction. Does not grant Pro.
 * Activation happens only after a verified Paddle webhook (paid subscription).
 */
export async function POST(req) {
  try {
    const gate = await requireClerkUser({ withBilling: true });
    if (!gate.ok) return gate.response;

    const body = await req.json().catch(() => ({}));
    const requested = String(body.plan || PLAN_IDS.PRO).toLowerCase();

    if (requested === PLAN_IDS.AGENCY) {
      return Response.json(
        { error: "Agency plan is not available for self-serve purchase yet." },
        { status: 422 }
      );
    }
    if (requested !== PLAN_IDS.PRO) {
      return Response.json({ error: "Unsupported plan." }, { status: 422 });
    }

    if (gate.isPaid && gate.entitlements?.planId === PLAN_IDS.PRO) {
      return Response.json({
        ok: true,
        alreadyActive: true,
        message: "You already have an active Pro subscription.",
        billing: gate.billing,
      });
    }

    if (!getPaddleProPriceId()) {
      return Response.json(
        {
          error: "Checkout is not available yet. Pro activates only after a verified successful payment.",
          code: "PADDLE_PRICE_ID_MISSING",
          pricing: {
            label: formatPlanPriceLabel(),
            currency: PRICING.currency,
            amountCents: PRICING.proMonthlyCents,
          },
        },
        { status: 503 }
      );
    }

    if (!isPaddleConfigured()) {
      return Response.json(
        {
          error: "Checkout is not available yet. Pro activates only after a verified successful payment.",
          code: "CHECKOUT_UNAVAILABLE",
          pricing: {
            label: formatPlanPriceLabel(),
            currency: PRICING.currency,
            amountCents: PRICING.proMonthlyCents,
          },
        },
        { status: 503 }
      );
    }

    const workspace = gate.workspace;
    if (!workspace?.id) {
      return Response.json({ error: "Workspace unavailable." }, { status: 503 });
    }

    let sessionId = null;
    try {
      sessionId = readFunnelSession(await cookies());
    } catch (e) {
      console.error("funnel session read failed:", e?.code || "error");
    }
    await recordTrustedCheckoutStart({
      workspaceId: workspace.id,
      sessionId,
    });

    const created = await createPaddleCheckoutTransaction({
      workspaceId: workspace.id,
      clerkUserId: gate.userId,
      email: gate.email,
    });

    if (!created.transactionId) {
      return Response.json({ error: "Could not start checkout. Try again." }, { status: 502 });
    }

    return Response.json({
      ok: true,
      provider: "paddle",
      transactionId: created.transactionId,
      checkoutUrl: created.checkoutUrl,
      environment: created.environment || getPaddleEnvironment(),
      customerEmail: created.customerEmail,
      plan: PLAN_IDS.PRO,
      priceLabel: formatPlanPriceLabel(),
      currency: PRICING.currency,
      amountCents: PRICING.proMonthlyCents,
    });
  } catch (e) {
    if (e?.code === "BILLING_NOT_CONFIGURED" || e?.code === "PADDLE_PRICE_ID_MISSING" || e?.code === "PADDLE_ENV_MISMATCH") {
      return Response.json(
        { error: "Checkout is not available yet. Pro activates only after a verified successful payment.", code: e.code },
        { status: 503 }
      );
    }
    if (e?.code === "PADDLE_ERROR") {
      console.error("paddle checkout error:", e.status || "request_failed");
      return Response.json({ error: "Could not start checkout. Try again." }, { status: 502 });
    }
    return mapDbError(e);
  }
}
