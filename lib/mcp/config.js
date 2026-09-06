/**
 * MCP V1 — feature flag, key format, and active-key limits.
 */

export const MCP_KEY_LIVE_PREFIX = "aso_live_";
export const MCP_KEY_TEST_PREFIX = "aso_test_";
export const MCP_KEY_RANDOM_BYTES = 16;
export const MCP_KEY_DISPLAY_PREFIX_LENGTH = 12;
export const MCP_KEY_NAME_MAX = 80;
export const MCP_DEFAULT_SCOPES = Object.freeze(["mcp"]);

/** Maximum active (non-revoked) keys per workspace. */
export const MCP_ACTIVE_KEYS_FREE = 2;
export const MCP_ACTIVE_KEYS_PAID = 8;

/** Reject oversized MCP JSON-RPC bodies (DoS / accidental key dumps). */
export const MCP_MAX_REQUEST_BYTES = 65_536;

const KEY_BODY_RE = /^[A-Za-z0-9_-]+$/;

/**
 * MCP is off unless explicitly enabled. When true, POST /mcp and /api/mcp/keys are available.
 */
export function isMcpEnabled(env = process.env) {
  return String(env.MCP_ENABLED || "").trim() === "true";
}

export function getMcpKeyPepper(env = process.env) {
  const pepper = String(env.MCP_KEY_PEPPER || "");
  return pepper || "";
}

export function maxActiveMcpKeys(entitlements) {
  return entitlements?.isPaid === true ? MCP_ACTIVE_KEYS_PAID : MCP_ACTIVE_KEYS_FREE;
}

/**
 * @param {string} secret
 * @returns {boolean}
 */
export function isMcpKeyFormat(secret) {
  const raw = String(secret || "");
  if (raw.length < MCP_KEY_LIVE_PREFIX.length + 16 || raw.length > 80) return false;
  const kind = raw.startsWith(MCP_KEY_LIVE_PREFIX)
    ? "live"
    : raw.startsWith(MCP_KEY_TEST_PREFIX)
      ? "test"
      : null;
  if (!kind) return false;
  const prefix = kind === "live" ? MCP_KEY_LIVE_PREFIX : MCP_KEY_TEST_PREFIX;
  const body = raw.slice(prefix.length);
  return body.length >= 16 && KEY_BODY_RE.test(body);
}

/** True for the MCP protocol endpoint (never Clerk-cookie gated). Key management stays under /api/mcp/keys. */
export function isMcpProtocolPath(pathname) {
  const p = String(pathname || "").split("?")[0];
  return p === "/mcp" || p.startsWith("/mcp/");
}
