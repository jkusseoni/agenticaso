/**
 * Scheduling helpers for monitoring.
 */

/**
 * ISO week key: 2026-W33
 * @param {Date} [date]
 */
export function weeklyScheduleKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * Month key: 2026-08
 * @param {Date} [date]
 */
export function monthlyScheduleKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * @param {"weekly"|"monthly"} frequency
 * @param {Date} [date]
 */
export function scheduleKeyFor(frequency, date = new Date()) {
  return frequency === "monthly" ? monthlyScheduleKey(date) : weeklyScheduleKey(date);
}

/**
 * @param {"weekly"|"monthly"} frequency
 * @param {Date} [from]
 */
export function computeNextRunAt(frequency, from = new Date()) {
  const d = new Date(from.getTime());
  if (frequency === "monthly") {
    d.setUTCDate(d.getUTCDate() + 30);
  } else {
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return d;
}

/**
 * @param {object} monitoring
 * @param {Date} [now]
 */
export function isDue(monitoring, now = new Date()) {
  if (!monitoring?.active) return false;
  if (!monitoring.nextRunAt) return true;
  return new Date(monitoring.nextRunAt).getTime() <= now.getTime();
}
