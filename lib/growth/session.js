/**
 * Opaque funnel session cookie. The value is a random id only.
 * It never carries a workspace id, Clerk id, email, or other identity.
 */

export const FUNNEL_SESSION_COOKIE = "agenticaso_funnel";
export const FUNNEL_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const FUNNEL_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function funnelSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: FUNNEL_SESSION_MAX_AGE_SECONDS,
  };
}

export function isFunnelSessionId(value) {
  return typeof value === "string" && FUNNEL_SESSION_ID_RE.test(value);
}

export function createFunnelSessionId() {
  return crypto.randomUUID();
}

/**
 * @param {{ get: (name: string) => { value?: string }|undefined, set: (name: string, value: string, options: object) => void }} cookieStore
 * @returns {string}
 */
export function ensureFunnelSession(cookieStore) {
  const existing = cookieStore.get(FUNNEL_SESSION_COOKIE)?.value;
  const sessionId = isFunnelSessionId(existing) ? existing : createFunnelSessionId();
  cookieStore.set(FUNNEL_SESSION_COOKIE, sessionId, funnelSessionCookieOptions());
  return sessionId;
}

/**
 * Read a previously issued session. Does not create or refresh the cookie.
 * @param {{ get: (name: string) => { value?: string }|undefined }|null|undefined} cookieStore
 * @returns {string|null}
 */
export function readFunnelSession(cookieStore) {
  const existing = cookieStore?.get?.(FUNNEL_SESSION_COOKIE)?.value;
  return isFunnelSessionId(existing) ? existing : null;
}
