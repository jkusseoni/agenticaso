import { getPrisma, isDatabaseConfigured, assertDb } from "@/lib/db";
import {
  getRazorpayConfig,
  verifyWebhookSignature,
} from "@/lib/billing";
import { processRazorpayWebhook } from "@/lib/billing/webhook.js";

export const runtime = "nodejs";

/**
 * POST /api/billing/webhook
 * Razorpay webhooks — signature verified, idempotent.
 */
export async function POST(req) {
  try {
    const { webhookSecret } = getRazorpayConfig();
    if (!webhookSecret) {
      return Response.json({ error: "Webhook secret not configured." }, { status: 503 });
    }
    if (!isDatabaseConfigured()) {
      return Response.json({ error: "Database is not configured yet." }, { status: 503 });
    }

    const rawBody = await req.text();
    const signature = req.headers.get("x-razorpay-signature") || "";

    if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
      return Response.json({ error: "Invalid signature." }, { status: 400 });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return Response.json({ error: "Invalid JSON." }, { status: 400 });
    }

    const eventId =
      payload?.event_id ||
      payload?.id ||
      `${payload?.event || "evt"}_${payload?.created_at || Date.now()}_${signature.slice(0, 16)}`;

    const db = assertDb(getPrisma());
    const result = await processRazorpayWebhook(db, {
      eventId: String(eventId),
      event: payload?.event || "unknown",
      payload,
    });

    return Response.json({ ok: true, ...result });
  } catch (e) {
    console.error("billing webhook error:", e?.message || e);
    return Response.json({ error: "Webhook processing failed." }, { status: 500 });
  }
}
