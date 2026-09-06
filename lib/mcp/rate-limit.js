/**
 * Durable MCP rate limits (Postgres), not in-memory Maps.
 * Three separate hourly buckets per workspace:
 *   mcp_http              — authenticated POST /mcp RPC calls
 *   scan_store            — Engine 1 scans (no AI quota)
 *   run_visibility_audit  — billed Multi-AI audits
 *
 * Unauthenticated ChatGPT traffic uses in-process IP buckets (no Workspace FK):
 *   mcp_public_http / mcp_public_scan
 */
import { rateLimited, _resetRateLimitsForTests } from "../api/rate-limit.js";

export const MCP_HTTP_ACTION = "mcp_http";
export const MCP_HTTP_PER_HOUR = 120;
export const MCP_SCAN_STORE_ACTION = "scan_store";
export const MCP_SCAN_STORE_PER_HOUR = 30;
export const MCP_AUDIT_ACTION = "run_visibility_audit";
export const MCP_AUDIT_PER_HOUR = 10;
export const MCP_RATE_WINDOW_MS = 3600_000;

/** ChatGPT No Auth path — stricter than authenticated workspace buckets. */
export const MCP_PUBLIC_HTTP_ACTION = "mcp_public_http";
export const MCP_PUBLIC_HTTP_PER_HOUR = 60;
export const MCP_PUBLIC_SCAN_ACTION = "mcp_public_scan";
export const MCP_PUBLIC_SCAN_PER_HOUR = 10;

export { _resetRateLimitsForTests };

export function mcpRateWindowStart(now = new Date()) {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), 0, 0, 0)
  );
}

/**
 * Increment the hourly bucket. Returns ok:false when the limit is exceeded
 * (the increment still lands so callers cannot burst by retrying immediately).
 *
 * @returns {Promise<{ ok: true, used: number, limit: number, remaining: number } | { ok: false, used: number, limit: number, retryAt: Date }>}
 */
export async function consumeMcpRateLimit(
  db,
  { workspaceId, action, limit, now = new Date() } = {}
) {
  const max = Math.max(1, Number(limit) || MCP_HTTP_PER_HOUR);
  const windowStart = mcpRateWindowStart(now);
  const retryAt = new Date(windowStart.getTime() + MCP_RATE_WINDOW_MS);

  if (!db?.mcpRateBucket?.upsert) {
    return { ok: false, used: max, limit: max, retryAt };
  }

  const row = await db.mcpRateBucket.upsert({
    where: {
      workspaceId_action_windowStart: { workspaceId, action, windowStart },
    },
    create: { workspaceId, action, windowStart, count: 1 },
    update: { count: { increment: 1 } },
  });

  const used = Number(row.count) || 0;
  if (used > max) {
    return { ok: false, used, limit: max, retryAt };
  }
  return { ok: true, used, limit: max, remaining: max - used };
}

/**
 * IP-keyed public MCP limits. Does not touch Workspace / McpRateBucket (FK-safe).
 * @returns {{ ok: true, limit: number } | { ok: false, limit: number }}
 */
export function consumePublicMcpRateLimit(clientId, { action, limit } = {}) {
  const id = String(clientId || "unknown").slice(0, 128) || "unknown";
  const act = String(action || MCP_PUBLIC_HTTP_ACTION);
  const max = Math.max(1, Number(limit) || MCP_PUBLIC_HTTP_PER_HOUR);
  if (rateLimited(`${act}:${id}`, max)) {
    return { ok: false, limit: max };
  }
  return { ok: true, limit: max };
}
