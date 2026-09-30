/**
 * Explicit research refresh for qualification_pending prospects only.
 * Preserves historical research jobs and evidence. Does not reopen
 * qualified/rejected. Does not delete qualification or critic rows.
 */

import { assertJobTransition, assertProspectTransition, nextProspectState } from "./state-machine.js";
import { GROWTH_ERROR_CODES, sanitizePersistedError } from "./persist-run.js";

const ACTIVE = ["pending", "running"];

export const RESEARCH_REFRESH_REASON = GROWTH_ERROR_CODES.SUPERSEDED_BY_RESEARCH_RERUN;

/**
 * @param {object} db
 * @param {{ prospectId: string, now?: Date }} [opts]
 */
export async function enqueueGrowthResearchRefresh(db, { prospectId, now } = {}) {
  if (!prospectId) return { ok: false, error: "missing_prospect_id" };
  const at = now instanceof Date ? now : new Date();
  const prospect = await db.growthProspect.findUnique({ where: { id: prospectId } });
  if (!prospect) return { ok: false, error: "missing_prospect" };
  if (prospect.lifecycleState === "qualified" || prospect.lifecycleState === "rejected") {
    return { ok: false, error: "terminal_not_reopenable" };
  }

  const existingResearch = await db.growthJob.findFirst({
    where: { prospectId, type: "research", status: { in: ACTIVE } },
    orderBy: { createdAt: "asc" },
  });

  const canReuse =
    existingResearch &&
    (prospect.lifecycleState === "qualification_pending" ||
      prospect.lifecycleState === "research_pending" ||
      prospect.lifecycleState === "researching");

  if (canReuse) {
    const cancelled = await cancelStaleQualifyJobs(db, { prospect, at });
    const next = await ensureResearchPending(db, prospect);
    return {
      ok: true,
      reused: true,
      created: false,
      job: existingResearch,
      cancelledQualifyJobIds: cancelled,
      prospect: next,
    };
  }

  if (prospect.lifecycleState !== "qualification_pending") {
    return { ok: false, error: "not_qualification_pending" };
  }

  return db.$transaction(async (tx) => {
    const cancelled = await cancelStaleQualifyJobs(tx, { prospect, at });
    const next = await ensureResearchPending(tx, prospect);
    const job = await tx.growthJob.create({
      data: {
        campaignId: prospect.campaignId,
        prospectId,
        type: "research",
        status: "pending",
        availableAt: at,
      },
    });
    return {
      ok: true,
      reused: false,
      created: true,
      job,
      cancelledQualifyJobIds: cancelled,
      prospect: next,
    };
  });
}

async function ensureResearchPending(db, prospect) {
  if (prospect.lifecycleState === "research_pending") {
    return prospect;
  }
  if (prospect.lifecycleState !== "qualification_pending") {
    return prospect;
  }
  const to = nextProspectState("qualification_pending", "refresh_research");
  assertProspectTransition("qualification_pending", to);
  await db.growthProspect.update({
    where: { id: prospect.id },
    data: { lifecycleState: to },
  });
  return { ...prospect, lifecycleState: to };
}

async function cancelStaleQualifyJobs(db, { prospect, at }) {
  const stale = await db.growthJob.findMany({
    where: { prospectId: prospect.id, type: "qualify", status: { in: ACTIVE } },
  });
  const ids = [];
  for (const job of stale) {
    assertJobTransition(job.status, "cancelled");
    await db.growthJob.update({
      where: { id: job.id },
      data: {
        status: "cancelled",
        finishedAt: at,
        leaseExpiresAt: null,
        lastErrorCode: RESEARCH_REFRESH_REASON,
        lastErrorMessage: sanitizePersistedError(RESEARCH_REFRESH_REASON),
      },
    });
    ids.push(job.id);
  }
  return ids;
}
