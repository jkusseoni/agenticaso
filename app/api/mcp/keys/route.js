import { getPrisma, isDatabaseConfigured, assertDb } from "@/lib/db";
import { requireClerkUser, mapDbError } from "@/lib/db/auth-gate";
import {
  createApiKey,
  isMcpEnabled,
  listApiKeys,
  mcpKeysPrecheck,
} from "@/lib/mcp";

export const runtime = "nodejs";

/**
 * GET /api/mcp/keys — list current workspace MCP keys (no hashes / no plaintext).
 */
export async function GET() {
  try {
    if (!isMcpEnabled()) {
      return Response.json({ error: "Not found." }, { status: 404 });
    }
    const gate = await requireClerkUser({ withBilling: true });
    if (!gate.ok) return gate.response;

    const pre = mcpKeysPrecheck({
      enabled: true,
      signedIn: true,
      dbConfigured: isDatabaseConfigured(),
      workspaceId: gate.workspace?.id,
    });
    if (!pre.ok) return Response.json(pre.body, { status: pre.status });

    const db = assertDb(getPrisma());
    const result = await listApiKeys(db, {
      workspaceId: gate.workspace.id,
      entitlements: gate.entitlements,
    });
    if (!result.ok) return Response.json(result.body, { status: result.status });
    return Response.json({
      apiKeys: result.apiKeys,
      limit: result.limit,
      activeCount: result.activeCount,
    });
  } catch (e) {
    return mapDbError(e);
  }
}

/**
 * POST /api/mcp/keys
 * Body: { name?: string, expiresAt?: string }
 * Returns plaintext `key` once. Never persisted or logged.
 */
export async function POST(req) {
  try {
    if (!isMcpEnabled()) {
      return Response.json({ error: "Not found." }, { status: 404 });
    }
    const gate = await requireClerkUser({ withBilling: true });
    if (!gate.ok) return gate.response;

    const pre = mcpKeysPrecheck({
      enabled: true,
      signedIn: true,
      dbConfigured: isDatabaseConfigured(),
      workspaceId: gate.workspace?.id,
    });
    if (!pre.ok) return Response.json(pre.body, { status: pre.status });

    const body = await req.json().catch(() => ({}));
    const db = assertDb(getPrisma());
    const result = await createApiKey(db, {
      workspaceId: gate.workspace.id,
      entitlements: gate.entitlements,
      name: body.name,
      expiresAt: body.expiresAt,
    });
    if (!result.ok) return Response.json(result.body, { status: result.status });

    return Response.json(
      { key: result.key, apiKey: result.apiKey },
      { status: 201 }
    );
  } catch (e) {
    return mapDbError(e);
  }
}
