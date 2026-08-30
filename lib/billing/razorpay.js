/**
 * Retired Razorpay adapter.
 * Signature helpers remain for historical tests. Nothing here grants Pro.
 */
import crypto from "crypto";

export function getRazorpayConfig() {
  return {
    keyId: "",
    keySecret: "",
    webhookSecret: "",
    planIdPro: "",
  };
}

export function isRazorpayConfigured() {
  return false;
}

/**
 * Verify Razorpay webhook signature (HMAC SHA256 hex of raw body).
 * Kept for unit tests of HMAC comparison. Does not grant entitlements.
 */
export function verifyWebhookSignature(rawBody, signature, secret) {
  if (!secret || !signature || rawBody == null) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(String(signature), "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function createProSubscription() {
  const err = new Error("Razorpay billing is retired. Paddle is the only payment provider.");
  err.code = "PROVIDER_RETIRED";
  throw err;
}

export async function cancelRazorpaySubscription() {
  const err = new Error("Razorpay billing is retired. Paddle is the only payment provider.");
  err.code = "PROVIDER_RETIRED";
  throw err;
}

export function mapRazorpayStatus(rzStatus) {
  const s = String(rzStatus || "").toLowerCase();
  if (s === "active" || s === "authenticated") return "active";
  if (s === "created" || s === "pending") return "trialing";
  if (s === "halted" || s === "pending") return "past_due";
  if (s === "cancelled") return "cancelled";
  if (s === "completed" || s === "expired") return "expired";
  return "expired";
}
