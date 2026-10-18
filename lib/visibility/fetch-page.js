/**
 * Fetch one public HTML page for site signals.
 * Every hop is revalidated, DNS is checked at connect time, and the body is
 * size- and time-limited. Failures return { ok: false } and never throw.
 */
import http from "node:http";
import https from "node:https";
import { createSafeLookup, parsePublicHttpUrl } from "./target.js";

export const PAGE_MAX_BYTES = 512 * 1024;
export const PAGE_TIMEOUT_MS = 8000;
export const PAGE_MAX_REDIRECTS = 3;

/**
 * @param {URL} url
 * @param {{ lookup: Function, userAgent: string, maxBytes: number, signal: AbortSignal }} opts
 * @returns {Promise<{ status: number, location: string|null, text: string }>}
 */
function requestOnce(url, { lookup, userAgent, maxBytes, signal }) {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: "GET",
        lookup,
        signal,
        headers: {
          "User-Agent": userAgent,
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "Accept-Encoding": "identity",
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = typeof res.headers.location === "string" ? res.headers.location : null;
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, location, text: "" });
          return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (size - maxBytes))));
            res.destroy();
            resolve({ status, location: null, text: Buffer.concat(chunks).toString("utf8") });
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, location: null, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * @param {URL|string} target
 * @param {{
 *   userAgent?: string,
 *   timeoutMs?: number,
 *   maxBytes?: number,
 *   maxRedirects?: number,
 *   lookup?: Function,
 *   request?: typeof requestOnce,
 *   signal?: AbortSignal|null
 * }} [opts]
 * @returns {Promise<{ ok: true, status: number, text: string, finalUrl: string } | { ok: false, reason: string }>}
 */
export async function fetchPublicPage(target, {
  userAgent = "AgenticasoBot/1.0",
  timeoutMs = PAGE_TIMEOUT_MS,
  maxBytes = PAGE_MAX_BYTES,
  maxRedirects = PAGE_MAX_REDIRECTS,
  lookup = createSafeLookup(),
  request = requestOnce,
  signal = null,
} = {}) {
  let url = parsePublicHttpUrl(target);
  if (!url) return { ok: false, reason: "invalid_url" };
  if (signal?.aborted) return { ok: false, reason: "aborted" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal;
  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const res = await request(url, { lookup, userAgent, maxBytes, signal: combined });
      if (res.status >= 300 && res.status < 400) {
        if (!res.location) return { ok: false, reason: "redirect_without_location" };
        const next = parsePublicHttpUrl(res.location, { base: url });
        if (!next) return { ok: false, reason: "blocked_redirect" };
        url = next;
        continue;
      }
      if (res.status < 200 || res.status >= 300) return { ok: false, reason: "http_status" };
      return { ok: true, status: res.status, text: res.text, finalUrl: url.href };
    }
    return { ok: false, reason: "too_many_redirects" };
  } catch (error) {
    if (error?.code === "BLOCKED_ADDRESS") return { ok: false, reason: "blocked_address" };
    if (signal?.aborted) return { ok: false, reason: "aborted" };
    if (ctrl.signal.aborted) return { ok: false, reason: "timeout" };
    return { ok: false, reason: "fetch_failed" };
  } finally {
    clearTimeout(timer);
  }
}
