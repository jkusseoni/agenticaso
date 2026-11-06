// Public scan endpoint: use the same SSRF-guarded scanner as MCP scan_store.
// Keep the Report response contract stable for the existing landing page.
import { scanStore } from "@/lib/scan/scan.js";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const result = await scanStore(body?.url);
    return Response.json(result, { status: result?.error ? 422 : 200 });
  } catch {
    return Response.json(
      { error: "Scan failed. Please try again." },
      { status: 500 },
    );
  }
}
