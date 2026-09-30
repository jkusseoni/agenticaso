/**
 * Atomic GrowthJob claim. Mirrors monitoring updateMany: never read-then-write.
 *
 * Stale recovery (not a distributed queue): a running job whose leaseExpiresAt
 * is in the past may be reclaimed. Crashes after pending→running wait for lease
 * expiry (GROWTH_JOB_LEASE_MS). Running rows with a null lease are not auto-reclaimed.
 */

export const GROWTH_JOB_LEASE_MS = Math.max(
  60_000,
  Number(process.env.GROWTH_JOB_LEASE_MS) || 15 * 60_000
);

export const CLAIM_STATES = Object.freeze([
  "claimed",
  "not_due",
  "already_claimed",
  "terminal",
  "missing",
]);

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

/**
 * @returns {Promise<{ status: string, job?: object }>}
 */
export async function claimGrowthJob(db, jobId, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now());
  const leaseMs = Number.isFinite(opts.leaseMs) ? opts.leaseMs : GROWTH_JOB_LEASE_MS;
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

  const result = await db.growthJob.updateMany({
    where: {
      id: jobId,
      OR: [
        { status: "pending", availableAt: { lte: now } },
        { status: "running", leaseExpiresAt: { lte: now } },
      ],
    },
    data: {
      status: "running",
      claimedAt: now,
      leaseExpiresAt,
      attempts: { increment: 1 },
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });

  if (result.count === 1) {
    const job = await db.growthJob.findUnique({ where: { id: jobId } });
    return { status: "claimed", job };
  }

  const current = await db.growthJob.findUnique({ where: { id: jobId } });
  if (!current) return { status: "missing" };
  if (TERMINAL.has(current.status)) return { status: "terminal", job: current };
  if (current.status === "pending") {
    const availableAt = current.availableAt instanceof Date ? current.availableAt : new Date(current.availableAt);
    if (availableAt.getTime() > now.getTime()) return { status: "not_due", job: current };
  }
  return { status: "already_claimed", job: current };
}
