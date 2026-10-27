/**
 * Shared audit shaping for diagnosis + MCP. Never includes raw AiTest.answer.
 */

export function stripAiTestAnswer(test) {
  if (!test || typeof test !== "object") return test;
  const { answer: _answer, ...rest } = test;
  return { ...rest, hasAnswer: Boolean(_answer) };
}

/**
 * Detail object used by diagnoseAudit (same fields as GET /api/audits/:id/diagnosis).
 * Raw answers are stripped so diagnosis never sees model text.
 */
export function shapeOwnedAudit(audit) {
  if (!audit) return null;
  return {
    id: audit.id,
    websiteId: audit.websiteId,
    website: {
      id: audit.website?.id,
      domain: audit.website?.domain,
      brandName: audit.website?.brandName,
      url: audit.website?.url,
      category: audit.website?.category,
    },
    status: audit.status,
    mentionShare: audit.mentionShare,
    recommendationShare: audit.recommendationShare,
    top3Share: audit.top3Share,
    providerMetrics: audit.providerMetrics,
    agenticScore: {
      found: { score: audit.foundScore, status: audit.foundStatus, note: null },
      understood: { score: audit.understoodScore, status: audit.understoodStatus, note: null },
      recommended: { score: audit.recommendedScore, status: audit.recommendedStatus, note: null },
      bought: { score: audit.boughtScore, status: audit.boughtStatus, note: null },
      overall: { score: audit.overallScore, status: audit.overallStatus, note: null },
    },
    intelligenceSummary: audit.intelligenceSummary,
    questions: (audit.questions || []).map((aq) => ({
      id: aq.question?.id || aq.id,
      question: aq.question?.question || aq.question,
      category: aq.question?.category || aq.category,
    })),
    aiTests: (audit.aiTests || []).map(stripAiTestAnswer),
    competitors: audit.competitors || [],
    perception: audit.perception || null,
  };
}

export function compactAuditListItem(a) {
  return {
    id: a.id,
    websiteId: a.websiteId,
    domain: a.website?.domain || null,
    brandName: a.website?.brandName || null,
    status: a.status,
    startedAt: a.startedAt,
    completedAt: a.completedAt,
    overallScore: a.overallScore,
    overallStatus: a.overallStatus,
    mentionShare: a.mentionShare,
    recommendationShare: a.recommendationShare,
    top3Share: a.top3Share,
  };
}

/**
 * Compact MCP result for a completed v2 visibility audit. Never includes raw answers.
 */
export function compactVisibilityAuditResult(payload, { advancedCompetitors = false } = {}) {
  if (!payload) return null;
  const intel = payload.intelligence || {};
  const overall = intel.agenticScore?.overall || {};
  const sov = intel.shareOfVoice || intel.overall || {};
  const list = intel.competitors?.list || intel.competitors?.top || [];
  const cap = advancedCompetitors ? 15 : 3;
  return {
    auditId: payload.persistence?.auditId || payload.audit?.id || null,
    websiteId: payload.persistence?.websiteId || payload.audit?.websiteId || null,
    domain: payload.domain || payload.audit?.domain || null,
    brand: payload.brand || payload.audit?.brand || null,
    overall: {
      score: overall.score ?? intel.overall?.score ?? null,
      status: overall.status ?? null,
    },
    mentionShare: sov.mentionShare ?? null,
    recommendationShare: sov.recommendationShare ?? null,
    top3Share: sov.top3Share ?? null,
    topCompetitors: list.slice(0, cap).map((c) => ({
      name: c.name,
      mentions: c.mentions,
      recommendationShare: c.recommendationShare,
      top3Share: c.top3Share,
    })),
    usage: payload.usage
      ? {
          aiTestsCharged: payload.usage.aiTestsCharged,
          expectedAiTests: payload.usage.expectedAiTests,
        }
      : null,
  };
}

/**
 * Compact owned audit for MCP get_audit — intelligence + scores, no raw answers.
 */
export function compactAuditDetail(audit) {
  const shaped = shapeOwnedAudit(audit);
  if (!shaped) return null;
  return {
    id: shaped.id,
    websiteId: shaped.websiteId,
    website: shaped.website,
    status: audit.status,
    startedAt: audit.startedAt,
    completedAt: audit.completedAt,
    mentionShare: shaped.mentionShare,
    recommendationShare: shaped.recommendationShare,
    top3Share: shaped.top3Share,
    providerMetrics: shaped.providerMetrics,
    agenticScore: {
      found: { score: audit.foundScore, status: audit.foundStatus },
      understood: { score: audit.understoodScore, status: audit.understoodStatus },
      recommended: { score: audit.recommendedScore, status: audit.recommendedStatus },
      bought: { score: audit.boughtScore, status: audit.boughtStatus },
      overall: { score: audit.overallScore, status: audit.overallStatus },
    },
    intelligenceSummary: shaped.intelligenceSummary,
    questions: (shaped.questions || []).slice(0, 50),
    aiTests: (shaped.aiTests || []).slice(0, 60),
    competitors: (shaped.competitors || []).slice(0, 15),
    perception: shaped.perception,
  };
}
