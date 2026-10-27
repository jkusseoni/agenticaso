import { validateStoreUrl } from "../../ai/audit.js";
import { scanStore } from "../../scan/scan.js";
import {
  MCP_PUBLIC_SCAN_ACTION,
  MCP_PUBLIC_SCAN_PER_HOUR,
  MCP_SCAN_STORE_ACTION,
  MCP_SCAN_STORE_PER_HOUR,
  consumeMcpRateLimit,
  consumePublicMcpRateLimit,
} from "../rate-limit.js";
import { mcpToolError, mcpToolStructuredJson } from "./result.js";

export function compactScanSummary(result, { href, domain } = {}) {
  if (!result || result.error) {
    return { error: result?.error || "Scan failed." };
  }
  return {
    domain: result.clean || domain || null,
    url: href || null,
    score: typeof result.total === "number" ? result.total : null,
    gap: typeof result.gap === "number" ? result.gap : null,
    verdict: typeof result.verdict === "string" ? result.verdict : null,
    isShopify: result.isShopify === true,
    pillars: (result.findings || []).map((f) => ({
      key: typeof f.key === "string" ? f.key : null,
      name: typeof f.t === "string" ? f.t : null,
      score: typeof f.score === "number" ? f.score : null,
      ok: f.ok === true,
      note: typeof f.note === "string" ? f.note : null,
    })),
  };
}

/**
 * Scan a public store. Does not consume AI-test quota.
 */
export async function runScanStoreTool(ctx, args = {}) {
  const validated = validateStoreUrl(args.url);
  if (!validated.ok) {
    return mcpToolError({ error: validated.error, code: "INVALID_URL" });
  }

  if (ctx?.mode === "public") {
    const limit = ctx.scanLimit != null ? ctx.scanLimit : MCP_PUBLIC_SCAN_PER_HOUR;
    const rate = consumePublicMcpRateLimit(ctx.publicClientId, {
      action: MCP_PUBLIC_SCAN_ACTION,
      limit,
    });
    if (!rate.ok) {
      return mcpToolError({
        error: "Rate limit hit — try later.",
        code: "RATE_LIMIT",
        limit: rate.limit,
      });
    }
  } else {
    const workspaceId = ctx?.workspace?.id;
    if (!workspaceId) {
      return mcpToolError({ error: "Unauthorized.", code: "UNAUTHORIZED" });
    }

    const limit = ctx.scanLimit != null ? ctx.scanLimit : MCP_SCAN_STORE_PER_HOUR;
    const rate = await consumeMcpRateLimit(ctx.db, {
      workspaceId,
      action: MCP_SCAN_STORE_ACTION,
      limit,
      now: ctx.now || new Date(),
    });
    if (!rate.ok) {
      return mcpToolError({
        error: "Rate limit hit — try later.",
        code: "RATE_LIMIT",
        limit: rate.limit,
        used: rate.used,
        retryAt: rate.retryAt,
      });
    }
  }

  const scan = ctx.scanStore || scanStore;
  const result = await scan(validated.href);
  if (result?.error) {
    return mcpToolError({ error: result.error, code: "SCAN_FAILED" });
  }
  return mcpToolStructuredJson(
    compactScanSummary(result, {
      href: validated.href,
      domain: validated.domain,
    })
  );
}
