/**
 * Growth dashboard allowlist. Server env only. Never a NEXT_PUBLIC_ variable.
 * Matching is exact after trimming entries. This does not read Clerk metadata.
 */

export function parseGrowthAdminClerkIds(raw = process.env.GROWTH_ADMIN_CLERK_IDS) {
  if (raw == null) return [];
  return String(raw)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * @param {string|null|undefined} userId
 * @param {string|null|undefined} [raw]
 */
export function isGrowthAdminClerkId(userId, raw = process.env.GROWTH_ADMIN_CLERK_IDS) {
  if (typeof userId !== "string" || userId.length === 0) return false;
  return parseGrowthAdminClerkIds(raw).includes(userId);
}
