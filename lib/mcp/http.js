import { createHash } from "node:crypto";
import { createClerkClient } from "@clerk/backend";

import { getPrisma, isDatabaseConfigured } from "../db/prisma.js";
import { sanitizeErrorMessage, SAFE_MESSAGES } from "../api/safe-error.js";

import {
  isMcpEnabled,
  getMcpKeyPepper,
  isMcpKeyFormat,
  MCP_MAX_REQUEST_BYTES,
} from "./config.js";

import { mcpCorsHeaders, withMcpCors } from "./cors.js";
import {
  jsonRpcErrorResponse,
  jsonRpcIdFromBody,
  MCP_RPC,
} from "./jsonrpc.js";

import {
  authenticateMcpApiKey,
  authenticateMcpOAuth,
} from "./context.js";

import { dispatchMcpProtocol } from "./server.js";
import { getMcpPublicSiteUrl } from "./account-status.js";

import {
  consumeMcpRateLimit,
  consumePublicMcpRateLimit,
  MCP_HTTP_ACTION,
  MCP_HTTP_PER_HOUR,
  MCP_PUBLIC_HTTP_ACTION,
  MCP_PUBLIC_HTTP_PER_HOUR,
} from "./rate-limit.js";

/**
 * Stateless Streamable HTTP MCP entry.
 * Public requests expose scan_store only.
 * Authenticated requests support Agenticaso API keys or Clerk OAuth tokens.
 */

function extractBearerToken(request) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : "";
}

function getPublicClientId(request) {
  const forwarded =
    request.headers.get("x-vercel-forwarded-for") ||
    request.headers.get("x-forwarded-for") ||
    request.headers.get("x-real-ip") ||
    "unknown";

  const client =
    String(forwarded).split(",")[0].trim().slice(0, 256) || "unknown";

  return createHash("sha256").update(client).digest("hex");
}

async function readJsonBody(request) {
  const declared = Number(request.headers.get("content-length") || 0);

  if (declared > MCP_MAX_REQUEST_BYTES) {
    return { ok: false, tooLarge: true };
  }

  const text = await request.text();

  if (text.length > MCP_MAX_REQUEST_BYTES) {
    return { ok: false, tooLarge: true };
  }

  if (!text) {
    return { ok: true, body: undefined };
  }

  try {
    return {
      ok: true,
      body: JSON.parse(text),
    };
  } catch {
    return { ok: false };
  }
}

function notFound() {
  return withMcpCors(
    Response.json(
      {
        error: "Not found.",
      },
      {
        status: 404,
      }
    )
  );
}

function methodNotAllowed(id) {
  return jsonRpcErrorResponse(
    405,
    id,
    MCP_RPC.SERVER,
    "Method not allowed.",
    undefined,
    {
      Allow: "POST, OPTIONS",
    }
  );
}

/**
 * Verify a Clerk OAuth access token from an MCP request.
 *
 * This is the production verifier.
 * Tests may inject options.authenticateOAuthRequest instead.
 */
async function authenticateClerkOAuthRequest(request) {
  const client = createClerkClient({
    secretKey: process.env.CLERK_SECRET_KEY,
    publishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  });

  const requestState = await client.authenticateRequest(request, {
    acceptsToken: "oauth_token",
  });

  if (!requestState?.isAuthenticated) {
    return null;
  }

  const clerkAuth = requestState.toAuth();

  if (!clerkAuth?.userId) {
    return null;
  }

  return {
    userId: clerkAuth.userId,
    scopes: Array.isArray(clerkAuth.scopes)
      ? clerkAuth.scopes
      : [],
  };
}

/**
 * @param {Request} request
 * @param {{
 *   enabled?: boolean,
 *   db?: object|null,
 *   now?: Date,
 *   siteUrl?: string,
 *   publicClientId?: string,
 *   publicHttpLimit?: number,
 *   mcpHttpLimit?: number,
 *   scanLimit?: number,
 *   auditLimit?: number,
 *   scanStore?: Function,
 *   visibilityAudit?: Function,
 *   authenticateOAuthRequest?: Function
 * }} [options]
 */
export async function handleMcpHttp(request, options = {}) {
  const enabled = options.enabled ?? isMcpEnabled();

  if (!enabled) {
    return notFound();
  }

  const method = String(request.method || "GET").toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: mcpCorsHeaders(),
    });
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
      return jsonRpcErrorResponse(
        413,
        null,
        MCP_RPC.INVALID_REQUEST,
        "Request too large."
      );
    }

    if (!parsed.ok) {
      return jsonRpcErrorResponse(
        400,
        null,
        MCP_RPC.PARSE,
        "Parse error: Invalid JSON"
      );
    }

    rpcId = jsonRpcIdFromBody(parsed.body);

    const authorization = request.headers.get("authorization");

    // No Authorization header = restricted public MCP.
    if (!authorization) {
      const publicClientId =
        options.publicClientId || getPublicClientId(request);

      const publicHttpLimit =
        options.publicHttpLimit != null
          ? options.publicHttpLimit
          : MCP_PUBLIC_HTTP_PER_HOUR;

      const publicRate = consumePublicMcpRateLimit(publicClientId, {
        action: MCP_PUBLIC_HTTP_ACTION,
        limit: publicHttpLimit,
      });

      if (!publicRate.ok) {
        return jsonRpcErrorResponse(
          429,
          rpcId,
          MCP_RPC.SERVER,
          SAFE_MESSAGES.RATE_LIMIT,
          {
            limit: publicRate.limit,
          }
        );
      }

      const sdkResponse = await dispatchMcpProtocol(request, {
        parsedBody: parsed.body,
        mode: "public",
        context: {
          publicClientId,
          siteUrl: options.siteUrl || getMcpPublicSiteUrl(),
          now: options.now || new Date(),
          scanStore: options.scanStore,
          scanLimit: options.scanLimit,
        },
      });

      return withMcpCors(sdkResponse);
    }

    // If Authorization was supplied, bad credentials must never fall back
    // to public mode.
    const token = extractBearerToken(request);

    if (!token) {
      return jsonRpcErrorResponse(
        401,
        rpcId,
        MCP_RPC.UNAUTHORIZED,
        SAFE_MESSAGES.UNAUTHORIZED
      );
    }

    if (!isDatabaseConfigured() && options.db === undefined) {
      return jsonRpcErrorResponse(
        503,
        rpcId,
        MCP_RPC.INTERNAL,
        SAFE_MESSAGES.DB_NOT_CONFIGURED
      );
    }

    const db =
      options.db !== undefined
        ? options.db
        : getPrisma();

    if (!db) {
      return jsonRpcErrorResponse(
        503,
        rpcId,
        MCP_RPC.INTERNAL,
        SAFE_MESSAGES.DB_NOT_CONFIGURED
      );
    }

    const now = options.now || new Date();
    const isApiKey = isMcpKeyFormat(token);

    // Agenticaso API keys require the server-side pepper.
    // Clerk OAuth tokens do not.
    if (isApiKey && !getMcpKeyPepper()) {
      return jsonRpcErrorResponse(
        503,
        rpcId,
        MCP_RPC.INTERNAL,
        "MCP is not configured yet."
      );
    }

    let auth = null;

    if (isApiKey) {
      auth = await authenticateMcpApiKey(db, token, {
        now,
      });
    } else {
      try {
        const verifyOAuth =
          options.authenticateOAuthRequest ||
          authenticateClerkOAuthRequest;

        const oauthIdentity = await verifyOAuth(request);

        if (oauthIdentity?.userId) {
          auth = await authenticateMcpOAuth(db, {
            userId: oauthIdentity.userId,
            scopes: Array.isArray(oauthIdentity.scopes)
              ? oauthIdentity.scopes
              : [],
          });
        }
      } catch {
        auth = null;
      }
    }

    // Never fall back to public mode when an Authorization header
    // was supplied but the credential was invalid.
    if (!auth?.workspace?.id) {
      return jsonRpcErrorResponse(
        401,
        rpcId,
        MCP_RPC.UNAUTHORIZED,
        SAFE_MESSAGES.UNAUTHORIZED
      );
    }

    const httpLimit =
      options.mcpHttpLimit != null
        ? options.mcpHttpLimit
        : MCP_HTTP_PER_HOUR;

    const rpcRate = await consumeMcpRateLimit(db, {
      workspaceId: auth.workspace.id,
      action: MCP_HTTP_ACTION,
      limit: httpLimit,
      now,
    });

    if (!rpcRate.ok) {
      return jsonRpcErrorResponse(
        429,
        rpcId,
        MCP_RPC.SERVER,
        SAFE_MESSAGES.RATE_LIMIT,
        {
          limit: rpcRate.limit,
          used: rpcRate.used,
          retryAt: rpcRate.retryAt,
        }
      );
    }

    const sdkResponse = await dispatchMcpProtocol(request, {
      parsedBody: parsed.body,
      context: {
        db,
        workspace: auth.workspace,
        apiKey: auth.apiKey,
        authType: auth.authType,
        scopes: auth.scopes,
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
    console.error(
      "mcp request failed:",
      sanitizeErrorMessage(e?.message)
    );

    return jsonRpcErrorResponse(
      500,
      rpcId,
      MCP_RPC.INTERNAL,
      SAFE_MESSAGES.GENERIC
    );
  }
}