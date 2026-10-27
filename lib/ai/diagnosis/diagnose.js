import { DIAGNOSIS_RULES } from "./rules.js";
import { assignPriority, sortIssues } from "./priority.js";

/**
 * Run evidence-based diagnosis on a persisted audit detail object.
 * Does not mutate the audit. Does not invent signals.
 *
 * @param {object} audit — shape from GET /api/audits/:id
 * @returns {{ auditId: string|null, issues: object[], summary: Record<string, number> }}
 */
export function diagnoseAudit(audit) {
  if (!audit) {
    return {
      auditId: null,
      issues: [],
      summary: { critical: 0, high: 0, medium: 0, low: 0 },
    };
  }

  const drafts = [];
  for (const rule of DIAGNOSIS_RULES) {
    try {
      const hit = rule(audit);
      if (hit) drafts.push(assignPriority(hit));
    } catch {
      /* skip broken rule */
    }
  }

  // Dedupe by id
  const byId = new Map();
  for (const issue of drafts) {
    const prev = byId.get(issue.id);
    if (!prev || (issue.severityScore || 0) > (prev.severityScore || 0)) {
      byId.set(issue.id, issue);
    }
  }

  const issues = sortIssues([...byId.values()]);
  const summary = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const i of issues) {
    if (summary[i.priority] != null) summary[i.priority] += 1;
  }

  return {
    auditId: audit.id || null,
    issues,
    summary,
  };
}
