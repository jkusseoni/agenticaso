/**
 * Deterministic Growth prospect (and job) state machines.
 * No database access. Lifecycle is independent of AI decisions.
 */

export const PROSPECT_LIFECYCLE = Object.freeze([
  "candidate",
  "research_pending",
  "researching",
  "researched",
  "qualification_pending",
  "qualifying",
  "qualified",
  "needs_review",
  "rejected",
  "failed",
]);

export const QUALIFICATION_DECISIONS = Object.freeze([
  "strong_fit",
  "possible_fit",
  "weak_fit",
  "not_fit",
  "insufficient_evidence",
]);

export const REVIEW_STATES = Object.freeze(["accepted", "needs_review", "rejected"]);

export const JOB_TYPES = Object.freeze(["research", "qualify", "critic"]);
export const JOB_STATUSES = Object.freeze(["pending", "running", "succeeded", "failed", "cancelled"]);

/** from → allowed next lifecycle states */
export const PROSPECT_TRANSITIONS = Object.freeze({
  candidate: Object.freeze(["research_pending"]),
  research_pending: Object.freeze(["researching", "failed"]),
  researching: Object.freeze(["researched", "failed", "research_pending"]),
  researched: Object.freeze(["qualification_pending"]),
  qualification_pending: Object.freeze(["qualifying", "failed", "research_pending"]),
  qualifying: Object.freeze(["qualified", "needs_review", "rejected", "failed", "qualification_pending"]),
  qualified: Object.freeze([]),
  needs_review: Object.freeze(["qualified", "rejected", "needs_review"]),
  rejected: Object.freeze([]),
  failed: Object.freeze(["research_pending"]),
});

export const JOB_TRANSITIONS = Object.freeze({
  pending: Object.freeze(["running", "cancelled"]),
  running: Object.freeze(["succeeded", "failed", "cancelled"]),
  succeeded: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

export const PROSPECT_EVENTS = Object.freeze({
  queue_research: { from: "candidate", to: "research_pending" },
  start_research: { from: "research_pending", to: "researching" },
  finish_research: { from: "researching", to: "researched" },
  fail_research: { from: "researching", to: "failed" },
  retry_research: { from: "researching", to: "research_pending" },
  reopen_failed_research: { from: "failed", to: "research_pending" },
  queue_qualify: { from: "researched", to: "qualification_pending" },
  start_qualify: { from: "qualification_pending", to: "qualifying" },
  refresh_research: { from: "qualification_pending", to: "research_pending" },
  accept: { from: "qualifying", to: "qualified" },
  needs_review: { from: "qualifying", to: "needs_review" },
  reject: { from: "qualifying", to: "rejected" },
  fail_qualify: { from: "qualifying", to: "failed" },
  retry_qualify: { from: "qualifying", to: "qualification_pending" },
  critic_retry_accept: { from: "needs_review", to: "qualified" },
  critic_retry_reject: { from: "needs_review", to: "rejected" },
  critic_retry_review: { from: "needs_review", to: "needs_review" },
});

export function canTransitionProspect(from, to) {
  return (PROSPECT_TRANSITIONS[from] || []).includes(to);
}

export function assertProspectTransition(from, to) {
  if (!canTransitionProspect(from, to)) {
    throw new Error(`illegal_prospect_transition:${from}->${to}`);
  }
  return true;
}

export function nextProspectState(from, event) {
  const spec = PROSPECT_EVENTS[event];
  if (!spec) throw new Error(`unknown_prospect_event:${event}`);
  if (from !== spec.from) throw new Error(`illegal_prospect_event:${event}_from_${from}`);
  return spec.to;
}

export function canTransitionJob(from, to) {
  return (JOB_TRANSITIONS[from] || []).includes(to);
}

export function assertJobTransition(from, to) {
  if (!canTransitionJob(from, to)) {
    throw new Error(`illegal_job_transition:${from}->${to}`);
  }
  return true;
}

export function isQualificationDecision(value) {
  return QUALIFICATION_DECISIONS.includes(value);
}

export function isReviewState(value) {
  return REVIEW_STATES.includes(value);
}

export function isProspectLifecycle(value) {
  return PROSPECT_LIFECYCLE.includes(value);
}

export function isJobType(value) {
  return JOB_TYPES.includes(value);
}

export function isJobStatus(value) {
  return JOB_STATUSES.includes(value);
}
