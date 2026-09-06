// app/api/scan/route.js
// Agenticaso — real agent-readiness scanner (Engine 1: site fetch, ₹0 cost).
// Response contract is unchanged: { clean, total, gap, revenue, findings, verdict, isShopify } | { error }.

import { scanStore } from "@/lib/scan/scan";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const result = await scanStore(body.url);
    const status = result.error ? 422 : 200;
    return Response.json(result, { status });
  } catch (e) {
    return Response.json({ error: "Scan failed. Please try again." }, { status: 500 });
  }
}
