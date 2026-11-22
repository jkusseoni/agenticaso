import { createHash } from "node:crypto";
import { rateLimited } from "../api/rate-limit.js";

export const PUBLIC_SCAN_MAX_BYTES = 4096;
export const PUBLIC_SCAN_PER_HOUR = 30;

// Best-effort per-instance protection. Enforce distributed limits at the edge for production.
export function publicScanLimited(request) {
  const forwarded = request.headers.get("x-vercel-forwarded-for");
  // Do not trust client-supplied x-forwarded-for/x-real-ip as an identity.
  const identity = forwarded ? forwarded.split(",")[0].trim().slice(0, 128) : "unknown";
  const key = createHash("sha256").update(identity || "unknown").digest("hex");
  return rateLimited("public_scan:" + key, PUBLIC_SCAN_PER_HOUR);
}

export async function readPublicScanBody(request) {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > PUBLIC_SCAN_MAX_BYTES)) {
    return { error: "too_large" };
  }
  const reader = request.body?.getReader();
  if (!reader) return { error: "invalid" };
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PUBLIC_SCAN_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return { error: "too_large" };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.url !== "string" || body.url.length > 2048) {
      return { error: "invalid" };
    }
    return { body };
  } catch {
    return { error: "invalid" };
  } finally {
    reader.releaseLock();
  }
}
