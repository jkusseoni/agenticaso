/**
 * Constant-time secret comparison for internal cron/worker routes.
 */
import crypto from "node:crypto";

export function safeSecretEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  if (a.length !== b.length || a.length === 0) {
    if (a.length > 0) crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}
