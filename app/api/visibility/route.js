// app/api/visibility/route.js
// Engine 2 — AI visibility check for Pro workspaces.
// Pro comes only from the server-side Paddle subscription (requireClerkUser).
// Usage is reserved before provider calls and settled after (lib/visibility/handler.js).

import { requireClerkUser } from "@/lib/db/auth-gate";
import { handleVisibilityRequest } from "@/lib/visibility/handler.js";

export const runtime = "nodejs";
export const maxDuration = 60;

const BASE = process.env.AICREDITS_BASE_URL;
const KEY = process.env.AICREDITS_API_KEY;
const PROVIDER_TIMEOUT_MS = 20_000;

async function chat(model, messages, { web = false, signal } = {}) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model, messages, temperature: web ? 0.2 : 0.3, max_tokens: 700 }),
    signal: signal || AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error("Provider request failed.");
    err.code = `PROVIDER_${res.status}`;
    throw err;
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

export async function POST(req) {
  const startedAt = Date.now();
  try {
    const gate = await requireClerkUser({ requirePaid: true, withBilling: true });
    if (!gate.ok) return gate.response;
    const body = await req.json().catch(() => ({}));
    return await handleVisibilityRequest({
      gate,
      body,
      deps: { chat, configured: Boolean(BASE && KEY), startedAt, signal: req.signal ?? null },
    });
  } catch (e) {
    console.error("visibility error:", e?.code || "error");
    return Response.json({ error: "Visibility check failed. Try again." }, { status: 500 });
  }
}
