/**
 * Stateless Streamable HTTP MCP entry (JSON only, no session store, no SSE).
 * Auth is Bearer API keys — never Clerk cookies.
 */
import { getPrisma, isDatabaseConfigured } from "../db/prisma.js";
import { sanitizeErrorMessage, SAFE_MESSAGES } from "../api/safe-error.js";
import { isMcpEnabled, getMcpKeyPepper, isMcpKeyFormat, MCP_MAX_REQUEST_BYTES } from "./config.js";
import { mcpCorsHeaders, withMcpCors } from "./cors.js";
import { jsonRpcErrorResponse, jsonRpcIdFromBody, MCP_RPC } from "./jsonrpc.js";
import { authenticateMcpApiKey } from "./context.js";
import { dispatchMcpProtocol } from "./server.js";
import { getMcpPublicSiteUrl } from "./account-status.js";
import { consumeMcpRateLimit, MCP_HTTP_ACTION, MCP_HTTP_PER_HOUR } from "./rate-limit.js";

function extractBearerToken(request) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : "";
}

async function readJsonBody(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MCP_MAX_REQUEST_BYTES) return { ok: false, tooLarge: true };
  const text = await request.text();
  if (text.length > MCP_MAX_REQUEST_BYTES) return { ok: false, tooLarge: true };
  if (!text) return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function notFound() {
  return withMcpCors(Response.json({ error: "Not found." }, { status: 404 }));
}

function methodNotAllowed(id) {
  return jsonRpcErrorResponse(405, id, MCP_RPC.SERVER, "Method not allowed.", undefined, {
    Allow: "POST, OPTIONS",
  });
}

/**
 * @param {Request} request
 * @param {{ enabled?: boolean, db?: object|null, now?: Date, siteUrl?: string }} [options]
 */
export async function handleMcpHttp(request, options = {}) {
  const enabled = options.enabled ?? isMcpEnabled();
  if (!enabled) return notFound();

  const method = String(request.method || "GET").toUpperCase();
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: mcpCorsHeaders() });
  }

  let rpcId = null;
  try {
    if (method === "GET" || method === "DELETE") {
      return methodNotAllowed(null);
    }
    if (method !== "POST") {
      return methodNotAllowed(null);
    }

    const parsed = await readJsonBody(request);
    if (parsed.tooLarge) {
      return jsonRpcErrorResponse(413, null, MCP_RPC.INVALID_REQUEST, "Request too large.");
    }
    if (!parsed.ok) {
      return jsonRpcErrorResponse(400, null, MCP_RPC.PARSE, "Parse error: Invalid JSON");
    }
    rpcId = jsonRpcIdFromBody(parsed.body);

    if (!isDatabaseConfigured() && options.db === undefined) {
      return jsonRpcErrorResponse(503, rpcId, MCP_RPC.INTERNAL, SAFE_MESSAGES.DB_NOT_CONFIGURED);
    }
    if (!getMcpKeyPepper()) {
      return jsonRpcErrorResponse(503, rpcId, MCP_RPC.INTERNAL, "MCP is not configured yet.");
    }

    const token = extractBearerToken(request);
    if (!token || !isMcpKeyFormat(token)) {
      return jsonRpcErrorResponse(401, rpcId, MCP_RPC.UNAUTHORIZED, SAFE_MESSAGES.UNAUTHORIZED);
    }

    const db = options.db !== undefined ? options.db : getPrisma();
    if (!db) {
      return jsonRpcErrorResponse(503, rpcId, MCP_RPC.INTERNAL, SAFE_MESSAGES.DB_NOT_CONFIGURED);
    }

    const now = options.now || new Date();
    const auth = await authenticateMcpApiKey(db, token, { now });
    if (!auth) {
      return jsonRpcErrorResponse(401, rpcId, MCP_RPC.UNAUTHORIZED, SAFE_MESSAGES.UNAUTHORIZED);
    }

    const httpLimit = options.mcpHttpLimit != null ? options.mcpHttpLimit : MCP_HTTP_PER_HOUR;
    const rpcRate = await consumeMcpRateLimit(db, {
      workspaceId: auth.workspace.id,
      action: MCP_HTTP_ACTION,
      limit: httpLimit,
      now,
    });
    if (!rpcRate.ok) {
      return jsonRpcErrorResponse(429, rpcId, MCP_RPC.SERVER, SAFE_MESSAGES.RATE_LIMIT, {
        limit: rpcRate.limit,
        used: rpcRate.used,
        retryAt: rpcRate.retryAt,
      });
    }

    const sdkResponse = await dispatchMcpProtocol(request, {
      parsedBody: parsed.body,
      context: {
        db,
        workspace: auth.workspace,
        apiKey: auth.apiKey,
        billing: auth.billing,
        entitlements: auth.billing?.entitlements,
        billingView: auth.billingView,
        siteUrl: options.siteUrl || getMcpPublicSiteUrl(),
        now,
        scanStore: options.scanStore,
        scanLimit: options.scanLimit,
        auditLimit: options.auditLimit,
        visibilityAudit: options.visibilityAudit,
      },
    });
    return withMcpCors(sdkResponse);
  } catch (e) {
    console.error("mcp request failed:", sanitizeErrorMessage(e?.message));
    return jsonRpcErrorResponse(500, rpcId, MCP_RPC.INTERNAL, SAFE_MESSAGES.GENERIC);
  }
}
