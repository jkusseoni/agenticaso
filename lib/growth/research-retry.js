/**
 * Explicit research retry for failed prospects only.
 * Does not reopen qualified/rejected. Does not revive a failed job row.
 */

import { assertProspectTransition, nextProspectState } from "./state-machine.js";

const ACTIVE_RESEARCH = ["pending", "running"];

export async function enqueueFailedResearchRetry(db, { prospectId, now } = {}) {
  if (!prospectId) return { ok: false, error: "missing_prospect_id" };
  const prospect = await db.growthProspect.findUnique({ where: { id: prospectId } });
  if (!prospect) return { ok: false, error: "missing_prospect" };
  if (prospect.lifecycleState === "qualified" || prospect.lifecycleState === "rejected") {
    return { ok: false, error: "terminal_not_reopenable" };
  }

  const existing = await db.growthJob.findFirst({
    where: { prospectId, type: "research", status: { in: ACTIVE_RESEARCH } },
  });
  if (existing && (prospect.lifecycleState === "failed" || prospect.lifecycleState === "research_pending")) {
    return { ok: true, reused: true, created: false, job: existing, prospect };
  }

  if (prospect.lifecycleState !== "failed") {
    return { ok: false, error: "not_failed" };
  }

  const to = nextProspectState("failed", "reopen_failed_research");
  assertProspectTransition("failed", to);

  await db.growthProspect.update({
    where: { id: prospectId },
    data: { lifecycleState: to },
  });

  const job = await db.growthJob.create({
    data: {
      campaignId: prospect.campaignId,
      prospectId,
      type: "research",
      status: "pending",
      availableAt: now instanceof Date ? now : new Date(),
    },
  });

  return {
    ok: true,
    reused: false,
    created: true,
    job,
    prospect: { ...prospect, lifecycleState: to },
  };
}
