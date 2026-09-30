/**
 * Server-side Pro checkout start. Call only after checkout creation is allowed.
 * A storage failure is returned and does not throw.
 */
import { FUNNEL_EVENTS, recordFunnelEvent } from "./funnel.js";
import { isFunnelSessionId } from "./session.js";

/**
 * @param {{ workspaceId?: string|null, sessionId?: string|null, record?: typeof recordFunnelEvent }} input
 */
export async function recordTrustedCheckoutStart({
  workspaceId = null,
  sessionId = null,
  record = recordFunnelEvent,
} = {}) {
  const trustedWorkspaceId = typeof workspaceId === "string" ? workspaceId.trim() : "";
  if (!trustedWorkspaceId) {
    return { ok: false, recorded: false, reason: "rejected", id: null };
  }

  try {
    return await record({
      event: FUNNEL_EVENTS.PRO_CHECKOUT_STARTED,
      sessionId: isFunnelSessionId(sessionId) ? sessionId : null,
      workspaceId: trustedWorkspaceId,
    });
  } catch (e) {
    console.error("funnel checkout event failed:", e?.code || "error");
    return { ok: false, recorded: false, reason: "persist_failed", id: null };
  }
}
