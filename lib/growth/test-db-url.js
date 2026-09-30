export function isDisposableGrowthTestUrl(raw) {
  if (!raw) return false;
  try {
    const u = new URL(String(raw).replace(/^postgresql:/i, "http:"));
    const host = u.hostname;
    const db = (u.pathname || "").replace(/^\//, "").split("?")[0];
    if (/neon\.tech|supabase\.co|vercel-storage|amazonaws\.com/i.test(host)) return false;
    if (!/^(localhost|127\.0\.0\.1)$/i.test(host)) return false;
    if (!/growth[_-]?test/i.test(db)) return false;
    return true;
  } catch {
    return false;
  }
}
