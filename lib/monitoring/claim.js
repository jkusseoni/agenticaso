/**
 * Atomic monitoring execution claim.
 * Prevents overlapping runs using a database conditional update.
 */

export const MONITORING_STALE_MS = 15 * 60 * 1000;

export async function claimMonitoringExecution(
  db,
  monitoring,
  { scheduleKey, manual = false, staleMs = MONITORING_STALE_MS } = {}
) {
  const staleBefore = new Date(Date.now() - staleMs);

  const where = {
    id: monitoring.id,
    active: true,
    AND: [
      {
        OR: [
          { lastStatus: { not: "running" } },
          { lastStatus: null },
          { lastRunAt: { lt: staleBefore } },
          { lastRunAt: null },
        ],
      },
      ...(manual ? [] : [{ NOT: { lastScheduleKey: scheduleKey } }]),
    ],
  };

  const result = await db.monitoring.updateMany({
    where,
    data: {
      lastScheduleKey: scheduleKey,
      lastStatus: "running",
      lastError: null,
      lastRunAt: new Date(),
    },
  });

  if (result.count === 1) {
    return { claimed: true };
  }

  let current = null;

  try {
    current = await db.monitoring.findUnique({
      where: { id: monitoring.id },
    });
  } catch {
    current = null;
  }

  if (
    !manual &&
    current?.lastScheduleKey === scheduleKey &&
    current?.lastStatus !== "running"
  ) {
    return { claimed: false, reason: "skipped_idempotent" };
  }

  if (current?.lastStatus === "running") {
    return { claimed: false, reason: "already_running" };
  }

  return {
    claimed: false,
    reason: manual ? "already_running" : "skipped_idempotent",
  };
}