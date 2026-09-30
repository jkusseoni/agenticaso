import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { getPrisma, isDatabaseConfigured } from "@/lib/db/prisma.js";
import { handleChatgptFunnelPost } from "@/lib/growth/click.js";

export const runtime = "nodejs";

/**
 * POST /api/funnel
 * Records chatgpt_plugin_cta_click only. The body is ignored.
 * Failure still returns ok so the ChatGPT link is unaffected.
 */
export async function POST() {
  let userId = null;
  try {
    const session = await auth();
    userId = session?.userId || null;
  } catch (e) {
    console.error("funnel auth lookup failed:", e?.code || "error");
  }

  let cookieStore = null;
  try {
    cookieStore = await cookies();
  } catch (e) {
    console.error("funnel cookie failed:", e?.code || "error");
    return Response.json({ ok: true });
  }

  const db = userId && isDatabaseConfigured() ? getPrisma() : null;
  return handleChatgptFunnelPost({ cookieStore, userId, db });
}
