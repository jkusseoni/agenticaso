import { getPrisma, isDatabaseConfigured, assertDb } from "@/lib/db";
import {
  getPaddleConfig,
  isPaddleWebhookConfigured,
  isPaddleEnvAligned,
  verifyPaddleWebhookSignature,
} from "@/lib/billing/paddle.js";
import { processPaddleWebhook } from "@/lib/billing/paddle-webhook.js";

export const runtime = "nodejs";

/**
 * POST /api/webhooks/paddle
 * Paddle Billing (v2) notifications — HMAC signature verified, idempotent after apply.
 */
export async function POST(req) {
  try {
    if (!isPaddleEnvAligned()) {
      return Response.json({ error: "Paddle environment mismatch." }, { status: 503 });
    }
    const { webhookSecret } = getPaddleConfig();
    if (!isPaddleWebhookConfigured() || !webhookSecret) {
      return Response.json({ error: "Webhook secret not configured." }, { status: 503 });
    }
    if (!isDatabaseConfigured()) {
      return Response.json({ error: "Database is not configured yet." }, { status: 503 });
    }

    const rawBody = await req.text();
    const signature = req.headers.get("paddle-signature") || "";

    if (!verifyPaddleWebhookSignature(rawBody, signature, webhookSecret)) {
      return Response.json({ error: "Invalid signature." }, { status: 400 });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return Response.json({ error: "Invalid JSON." }, { status: 400 });
    }

    const eventId = payload?.event_id || payload?.notification_id;
    if (!eventId) {
      return Response.json({ error: "Missing event id." }, { status: 400 });
    }

    const db = assertDb(getPrisma());
    const result = await processPaddleWebhook(db, {
      eventId: String(eventId),
      eventType: payload?.event_type || "unknown",
      data: payload?.data,
      payload,
    });

    return Response.json({ ok: true, ...result });
  } catch (e) {
    if (e?.code === "PADDLE_PRICE_ID_MISSING" || e?.code === "PADDLE_ENV_MISMATCH") {
      return Response.json({ error: "Webhook is not ready." }, { status: 503 });
    }
    console.error("paddle webhook error:", e?.code || "processing_failed");
    return Response.json({ error: "Webhook processing failed." }, { status: 500 });
  }
}
