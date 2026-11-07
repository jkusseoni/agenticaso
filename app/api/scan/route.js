// Public scan endpoint: SSRF-guarded scanner with best-effort per-instance abuse controls.
import { scanStore } from "@/lib/scan/scan.js";
import { publicScanLimited, readPublicScanBody } from "@/lib/scan/public-guard.js";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req) {
  try {
    if (publicScanLimited(req)) {
      return Response.json({ error: "Too many scans. Please try again later." }, { status: 429 });
    }
    const parsed = await readPublicScanBody(req);
    if (parsed.error === "too_large") {
      return Response.json({ error: "Request body too large." }, { status: 413 });
    }
    if (parsed.error) {
      return Response.json({ error: "Provide a valid website URL." }, { status: 422 });
    }
    const result = await scanStore(parsed.body.url);
    return Response.json(result, { status: result?.error ? 422 : 200 });
  } catch {
    return Response.json({ error: "Scan failed. Please try again." }, { status: 500 });
  }
}
