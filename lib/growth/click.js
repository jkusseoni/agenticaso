/**
 * Homepage ChatGPT CTA persistence.
 * The event name is fixed. Callers cannot supply an event name or workspace id.
 */
import { FUNNEL_EVENTS, recordFunnelEvent } from "./funnel.js";
import { ensureFunnelSession } from "./session.js";

/**
 * Existing workspace only. A click does not create a workspace.
 * @param {{ userId?: string|null, db?: { workspace?: { findUnique?: Function } }|null }} input
 * @returns {Promise<string|null>}
 */
export async function lookupSignedInWorkspaceId({ userId = null, db = null } = {}) {
  if (!userId || !db?.workspace?.findUnique) return null;
  try {
    const row = await db.workspace.findUnique({
      where: { clerkUserId: userId },
      select: { id: true },
    });
    return row?.id || null;
  } catch (e) {
    console.error("funnel workspace lookup failed:", e?.code || "error");
    return null;
  }
}

/**
 * @param {{
 *   cookieStore: { get: Function, set: Function },
 *   userId?: string|null,
 *   db?: object|null,
 *   record?: typeof recordFunnelEvent
 * }} input
 */
export async function handleChatgptFunnelPost({
  cookieStore,
  userId = null,
  db = null,
  record = recordFunnelEvent,
} = {}) {
  try {
    const sessionId = ensureFunnelSession(cookieStore);
    const workspaceId = await lookupSignedInWorkspaceId({ userId, db });
    await record({
      event: FUNNEL_EVENTS.CHATGPT_PLUGIN_CTA_CLICK,
      sessionId,
      workspaceId,
    });
  } catch (e) {
    console.error("funnel click failed:", e?.code || "error");
  }
  return Response.json({ ok: true });
}
