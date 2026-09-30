/**
 * Bounded root-fetch failure classification and one apex↔www host variant.
 * Compatibility only — not a WAF bypass. Does not persist response bodies.
 */

export const MAX_ROOT_HOST_ATTEMPTS = 2;

export const ROOT_FAILURE_KIND = Object.freeze({
  HTTP_FORBIDDEN: "HTTP_FORBIDDEN",
  HTTP_UNAUTHORIZED: "HTTP_UNAUTHORIZED",
  HTTP_RATE_LIMITED: "HTTP_RATE_LIMITED",
  HTTP_NOT_FOUND: "HTTP_NOT_FOUND",
  HTTP_SERVER_ERROR: "HTTP_SERVER_ERROR",
  NETWORK_TIMEOUT: "NETWORK_TIMEOUT",
  NETWORK_ERROR: "NETWORK_ERROR",
  SSRF_REJECTED: "SSRF_REJECTED",
  REDIRECT_REJECTED: "REDIRECT_REJECTED",
  CONTENT_TOO_LARGE: "CONTENT_TOO_LARGE",
  OTHER_HTTP_ERROR: "OTHER_HTTP_ERROR",
});

/** Failures that may attempt exactly one www/apex host variant. */
export const ROOT_HOST_VARIANT_ELIGIBLE = Object.freeze([
  ROOT_FAILURE_KIND.HTTP_FORBIDDEN,
  ROOT_FAILURE_KIND.HTTP_NOT_FOUND,
  ROOT_FAILURE_KIND.NETWORK_ERROR,
]);

const BOT_BLOCK_HEADER =
  /cf-mitigated|cf-challenge|x-sucuri|x-content-type-options:\s*nosniff/i;
const BOT_BLOCK_BODY =
  /just a moment|attention required|checking your browser|cf-browser-verification|challenge-platform|access denied|bot protection|why have i been blocked|captcha|enable javascript and cookies/i;

/**
 * Classify a failed root fetch. `body` is scanned in memory only; callers must not persist it.
 */
export function classifyRootFetchFailure({ status = null, error = "", headers = null, body = "" } = {}) {
  const message = String(error || "");
  const lower = message.toLowerCase();
  const httpStatus = Number.isFinite(Number(status)) && Number(status) > 0 ? Number(status) : null;

  let kind = ROOT_FAILURE_KIND.OTHER_HTTP_ERROR;
  if (/private or reserved|not a public|ssrf|hostname resolves to a private/i.test(lower)) {
    kind = ROOT_FAILURE_KIND.SSRF_REJECTED;
  } else if (/credentials/i.test(lower)) {
    kind = ROOT_FAILURE_KIND.SSRF_REJECTED;
  } else if (/too many redirects/i.test(lower)) {
    kind = ROOT_FAILURE_KIND.REDIRECT_REJECTED;
  } else if (/too large|content.?too.?large|body too large/i.test(lower)) {
    kind = ROOT_FAILURE_KIND.CONTENT_TOO_LARGE;
  } else if (/timed out|timeout/i.test(lower)) {
    kind = ROOT_FAILURE_KIND.NETWORK_TIMEOUT;
  } else if (/enotfound|eai_again|getaddrinfo|econnrefused|econnreset|network error|socket hang up|dns/i.test(lower)) {
    kind = ROOT_FAILURE_KIND.NETWORK_ERROR;
  } else if (/send a valid|only http|not allowed/i.test(lower)) {
    kind = ROOT_FAILURE_KIND.SSRF_REJECTED;
  } else if (httpStatus === 401) {
    kind = ROOT_FAILURE_KIND.HTTP_UNAUTHORIZED;
  } else if (httpStatus === 403) {
    kind = ROOT_FAILURE_KIND.HTTP_FORBIDDEN;
  } else if (httpStatus === 404) {
    kind = ROOT_FAILURE_KIND.HTTP_NOT_FOUND;
  } else if (httpStatus === 429) {
    kind = ROOT_FAILURE_KIND.HTTP_RATE_LIMITED;
  } else if (httpStatus >= 500 && httpStatus <= 599) {
    kind = ROOT_FAILURE_KIND.HTTP_SERVER_ERROR;
  } else if (httpStatus && httpStatus >= 400) {
    kind = ROOT_FAILURE_KIND.OTHER_HTTP_ERROR;
  } else if (message) {
    kind = ROOT_FAILURE_KIND.NETWORK_ERROR;
  }

  const possibleBotBlock = detectPossibleBotBlockHint(kind, httpStatus, headers, body);
  return {
    kind,
    httpStatus,
    possibleBotBlock,
    eligibleForHostVariant: ROOT_HOST_VARIANT_ELIGIBLE.includes(kind),
  };
}

/**
 * Hint only. 403 alone is not a proven bot block.
 */
export function detectPossibleBotBlockHint(kind, httpStatus, headers, body) {
  if (kind !== ROOT_FAILURE_KIND.HTTP_FORBIDDEN && httpStatus !== 403) return false;
  const headerBlob = flattenHeaders(headers);
  const hasHeaderHint = Boolean(
    headerBlob && (BOT_BLOCK_HEADER.test(headerBlob) || /cloudflare|cf-ray|sucuri|akamai|bot.management|captcha/i.test(headerBlob))
  );
  const hasBodyHint = Boolean(body && BOT_BLOCK_BODY.test(String(body).slice(0, 8000)));
  return hasHeaderHint || hasBodyHint;
}

export function isEligibleForRootHostVariant(failure) {
  return Boolean(failure?.eligibleForHostVariant);
}

/**
 * Apex → www or www → apex. Same path/query. HTTPS only. No shop./store./www2.
 */
export function apexWwwVariantHref(rawHref, registrable) {
  let u;
  try {
    u = new URL(rawHref);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  const reg = String(registrable || "").toLowerCase().replace(/^www\./, "");
  if (!reg || !host.includes(".")) return null;
  if (/^www\d+\./i.test(host)) return null;
  if (host === `www.${reg}`) u.hostname = reg;
  else if (host === reg) u.hostname = `www.${reg}`;
  else return null;
  if (u.hostname === host) return null;
  return u.href;
}

export function formatRootFailureMessage(failure, { rootAttempts = 1, variantAttempted = false } = {}) {
  const status = failure?.httpStatus;
  let message = "Could not fetch the storefront homepage.";
  if (failure?.kind === ROOT_FAILURE_KIND.HTTP_FORBIDDEN && status === 403) {
    message = "Root fetch returned HTTP 403.";
  } else if (failure?.kind === ROOT_FAILURE_KIND.HTTP_NOT_FOUND && status === 404) {
    message = "Root fetch returned HTTP 404.";
  } else if (failure?.kind === ROOT_FAILURE_KIND.HTTP_UNAUTHORIZED) {
    message = `Root fetch returned HTTP ${status || 401}.`;
  } else if (failure?.kind === ROOT_FAILURE_KIND.HTTP_RATE_LIMITED) {
    message = "Root fetch returned HTTP 429.";
  } else if (failure?.kind === ROOT_FAILURE_KIND.HTTP_SERVER_ERROR) {
    message = `Root fetch returned HTTP ${status || 500}.`;
  } else if (failure?.kind === ROOT_FAILURE_KIND.NETWORK_TIMEOUT) {
    message = "Root fetch timed out.";
  } else if (failure?.kind === ROOT_FAILURE_KIND.SSRF_REJECTED) {
    message = "Root fetch was rejected as unsafe.";
  } else if (failure?.kind === ROOT_FAILURE_KIND.REDIRECT_REJECTED) {
    message = "Root fetch redirected unsafely.";
  } else if (failure?.kind === ROOT_FAILURE_KIND.CONTENT_TOO_LARGE) {
    message = "Root fetch response was too large.";
  } else if (status) {
    message = `Root fetch returned HTTP ${status}.`;
  }
  if (rootAttempts > 1 || variantAttempted) {
    message += ` rootAttempts=${rootAttempts} variantAttempted=${Boolean(variantAttempted)}`;
  }
  return message.slice(0, 280);
}

function flattenHeaders(headers) {
  if (!headers) return "";
  if (typeof headers.get === "function") {
    const names = ["server", "cf-mitigated", "cf-ray", "x-sucuri-id", "via", "x-cdn"];
    return names
      .map((n) => {
        const v = headers.get(n);
        return v ? `${n}:${v}` : "";
      })
      .filter(Boolean)
      .join(";");
  }
  return Object.entries(headers)
    .filter(([, v]) => v != null && String(v).length > 0)
    .map(([k, v]) => `${k}:${Array.isArray(v) ? v.join(",") : v}`)
    .join(";");
}
