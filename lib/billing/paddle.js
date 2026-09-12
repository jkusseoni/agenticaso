/**
 * Paddle Billing (v2) adapter — sandbox by default.
 * Server-only. Never expose PADDLE_API_KEY or PADDLE_WEBHOOK_SECRET to the client.
 */
import crypto from "node:crypto";

const SANDBOX_API = "https://sandbox-api.paddle.com";
const LIVE_API = "https://api.paddle.com";
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

export function normalizePaddleEnvValue(raw, fallback = "sandbox") {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return fallback;
  if (v === "production" || v === "live") return "production";
  return "sandbox";
}

/**
 * Server Paddle environment. Defaults to sandbox.
 * Does not call Live APIs unless PADDLE_ENV is explicitly production/live AND the public env matches.
 */
export function getPaddleEnvironment() {
  return normalizePaddleEnvValue(process.env.PADDLE_ENV, "sandbox");
}

export function getPublicPaddleEnvironment() {
  const raw = process.env.NEXT_PUBLIC_PADDLE_ENV;
  if (raw == null || String(raw).trim() === "") {
    return "sandbox";
  }
  return normalizePaddleEnvValue(raw, "sandbox");
}

/**
 * True when server and client Paddle environments agree.
 * Unset public env is treated as sandbox (client overlay default).
 */
export function isPaddleEnvAligned() {
  return getPaddleEnvironment() === getPublicPaddleEnvironment();
}

export function assertPaddleEnvAligned() {
  if (isPaddleEnvAligned()) return;
  const err = new Error("Paddle environment mismatch. Server and client must both be sandbox or both be production.");
  err.code = "PADDLE_ENV_MISMATCH";
  throw err;
}

/** Server-only Pro price id. Never read NEXT_PUBLIC_PADDLE_PRO_PRICE_ID. */
export function getPaddleProPriceId() {
  return String(process.env.PADDLE_PRICE_ID_PRO || "").trim();
}

export function getPaddleConfig() {
  const environment = getPaddleEnvironment();
  return {
    environment,
    aligned: isPaddleEnvAligned(),
    apiKey: process.env.PADDLE_API_KEY || "",
    webhookSecret: process.env.PADDLE_WEBHOOK_SECRET || "",
    priceIdPro: getPaddleProPriceId(),
    clientToken: process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN || "",
    apiBase: environment === "production" && isPaddleEnvAligned() ? LIVE_API : SANDBOX_API,
  };
}

export function isPaddleConfigured() {
  if (!isPaddleEnvAligned()) return false;
  const c = getPaddleConfig();
  return Boolean(c.apiKey && c.priceIdPro);
}

export function isPaddleWebhookConfigured() {
  return Boolean(getPaddleConfig().webhookSecret);
}

/**
 * Paddle Billing notification signature (ts + h1 HMAC-SHA256).
 * @param {string} rawBody
 * @param {string} signatureHeader Paddle-Signature
 * @param {string} secret
 * @param {{ now?: number, maxAgeMs?: number }} [opts]
 */
export function verifyPaddleWebhookSignature(rawBody, signatureHeader, secret, opts = {}) {
  if (!rawBody || !signatureHeader || !secret) return false;
  const parsed = parsePaddleSignature(signatureHeader);
  if (!parsed) return false;

  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : SIGNATURE_MAX_AGE_MS;
  const tsMs = Number(parsed.ts) * 1000;
  if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > maxAgeMs) return false;

  const expected = crypto.createHmac("sha256", secret).update(`${parsed.ts}:${rawBody}`).digest("hex");
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(parsed.h1, "hex");
    if (a.length !== b.length || a.length === 0) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function parsePaddleSignature(header) {
  /** @type {Record<string, string>} */
  const parts = {};
  for (const chunk of String(header).split(";")) {
    const idx = chunk.indexOf("=");
    if (idx <= 0) continue;
    const key = chunk.slice(0, idx).trim();
    const value = chunk.slice(idx + 1).trim();
    if (key) parts[key] = value;
  }
  if (!parts.ts || !parts.h1) return null;
  return { ts: parts.ts, h1: parts.h1 };
}

export function mapPaddleSubscriptionStatus(paddleStatus) {
  const status = String(paddleStatus || "").toLowerCase();
  if (status === "active") return "active";
  if (status === "trialing") return "trialing";
  if (status === "past_due") return "past_due";
  if (status === "paused") return "past_due";
  if (status === "canceled" || status === "cancelled") return "cancelled";
  return "expired";
}

export function buildPaddleCheckoutCustomData({ workspaceId, clerkUserId } = {}) {
  return {
    workspaceId: String(workspaceId || "").trim(),
    clerkUserId: String(clerkUserId || "").trim(),
    plan: "pro",
  };
}

/**
 * Price ids present on a Paddle subscription or transaction entity.
 */
export function extractPaddlePriceIds(entity) {
  const ids = [];
  const seen = new Set();
  const add = (value) => {
    const id = String(value || "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  add(entity?.price_id);
  add(entity?.price?.id);
  const items = entity?.items || entity?.details?.line_items || [];
  for (const item of items) {
    add(item?.price_id);
    add(item?.price?.id);
  }
  return ids;
}

export function paddleEntityMatchesProPrice(entity, priceIdPro = getPaddleProPriceId()) {
  const expected = String(priceIdPro || "").trim();
  if (!expected) return false;
  return extractPaddlePriceIds(entity).includes(expected);
}

/**
 * Create a draft/ready Paddle transaction for overlay checkout.
 * Does not write a local Subscription row and does not grant Pro.
 */
export async function createPaddleCheckoutTransaction({
  workspaceId,
  clerkUserId,
  email = null,
} = {}) {
  assertPaddleEnvAligned();
  const config = getPaddleConfig();
  if (!config.apiKey) {
    const err = new Error("Paddle is not configured.");
    err.code = "BILLING_NOT_CONFIGURED";
    throw err;
  }
  if (!config.priceIdPro) {
    const err = new Error("Paddle Price ID is not configured.");
    err.code = "PADDLE_PRICE_ID_MISSING";
    throw err;
  }

  const customData = buildPaddleCheckoutCustomData({ workspaceId, clerkUserId });
  if (!customData.workspaceId || !customData.clerkUserId) {
    const err = new Error("Checkout identity is missing.");
    err.code = "VALIDATION";
    throw err;
  }

  const body = {
    items: [{ price_id: config.priceIdPro, quantity: 1 }],
    collection_mode: "automatic",
    currency_code: "USD",
    custom_data: customData,
  };

  const data = await paddleRequest("POST", "/transactions", body);
  return {
    transactionId: data?.id || null,
    status: data?.status || null,
    checkoutUrl: data?.checkout?.url || null,
    environment: config.environment,
    customerEmail: email || null,
  };
}

export async function cancelPaddleSubscription(subscriptionId, { effectiveFrom = "next_billing_period" } = {}) {
  if (!subscriptionId) {
    const err = new Error("Missing Paddle subscription id.");
    err.code = "VALIDATION";
    throw err;
  }
  return paddleRequest("POST", `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
    effective_from: effectiveFrom,
  });
}

async function paddleRequest(method, path, body) {
  assertPaddleEnvAligned();
  const { apiKey, apiBase } = getPaddleConfig();
  if (!apiKey) {
    const err = new Error("Paddle is not configured.");
    err.code = "BILLING_NOT_CONFIGURED";
    throw err;
  }

  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Paddle-Version": "1",
      "Content-Type": "application/json",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));

if (!res.ok) {
  const paddleError = json?.error || {};
  const requestId = json?.meta?.request_id || null;

  console.error("Paddle API request failed:", {
    method,
    path,
    status: res.status,
    code: paddleError.code || null,
    detail: paddleError.detail || null,
    requestId,
  });

  const err = new Error("Paddle request failed.");
  err.code = "PADDLE_ERROR";
  err.status = res.status;
  err.paddleCode = paddleError.code || null;
  err.paddleRequestId = requestId;
  throw err;
}
  return json?.data ?? json;
}
