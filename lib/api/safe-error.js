/**
 * Production-safe client error responses (no secrets / stack traces).
 */

const SAFE_MESSAGES = {
  UNAUTHORIZED: "Unauthorized.",
  NOT_FOUND: "Not found.",
  VALIDATION: "Invalid request.",
  RATE_LIMIT: "Rate limit hit — try later.",
  DB_NOT_CONFIGURED: "Database is not configured yet.",
  GENERIC: "Request failed.",
};

/**
 * Strip sensitive patterns from any accidental message leakage.
 */
export function sanitizeErrorMessage(message, fallback = SAFE_MESSAGES.GENERIC) {
  if (!message || typeof message !== "string") return fallback;
  const lower = message.toLowerCase();
  if (
    lower.includes("password") ||
    lower.includes("secret") ||
    lower.includes("api_key") ||
    lower.includes("apikey") ||
    lower.includes("connection string") ||
    lower.includes("database_url") ||
    lower.includes("bearer ") ||
    lower.includes("sk-") ||
    lower.includes("rzp_test") ||
    lower.includes("rzp_live") ||
    lower.includes("aso_live_") ||
    lower.includes("aso_test_") ||
    lower.includes("mcp_key_pepper") ||
    lower.includes("authorization") ||
    lower.includes("pdl_") ||
    lower.includes("paddle-signature") ||
    (message.includes("at ") && message.includes(".js:"))
  ) {
    return fallback;
  }
  // Cap length
  return message.slice(0, 240);
}

export function safeJsonError(message, status = 500, extra = {}) {
  return Response.json(
    {
      error: sanitizeErrorMessage(message, SAFE_MESSAGES.GENERIC),
      ...extra,
    },
    { status }
  );
}

export { SAFE_MESSAGES };
