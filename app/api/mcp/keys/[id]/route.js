import { getPrisma, isDatabaseConfigured, assertDb } from "@/lib/db";
import { requireClerkUser, mapDbError } from "@/lib/db/auth-gate";
import { isMcpEnabled, mcpKeysPrecheck, revokeApiKey } from "@/lib/mcp";

export const runtime = "nodejs";

/**
 * DELETE /api/mcp/keys/:id — revoke an owned key (idempotent).
 */
export async function DELETE(_req, ctx) {
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

    const { id } = await ctx.params;
    const db = assertDb(getPrisma());
    const result = await revokeApiKey(db, {
      workspaceId: gate.workspace.id,
      keyId: id,
    });
    if (!result.ok) return Response.json(result.body, { status: result.status });
    return Response.json({ ok: true, apiKey: result.apiKey });
  } catch (e) {
    return mapDbError(e);
  }
}
