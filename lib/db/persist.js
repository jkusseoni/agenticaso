import { upsertBuyerQuestions } from "./questions.js";
import { getOrCreateWebsite, getOrCreateWorkspace } from "./ownership.js";

/**
 * Whether to persist raw AI answers. Default true; set STORE_RAW_ANSWERS=false to omit.
 */
export function shouldStoreRawAnswers() {
  const v = process.env.STORE_RAW_ANSWERS;
  if (v == null || v === "") return true;
  return !["0", "false", "no", "off"].includes(String(v).toLowerCase());
}

/**
 * Persist a completed v2 audit + intelligence payload.
 * Partial provider failures (error field on AiTest) are stored normally.
 *
 * @param {import("@prisma/client").PrismaClient} db
 * @param {object} opts
 * @param {string} opts.clerkUserId
 * @param {string|null} [opts.email]
 * @param {object} opts.v2Payload — response from withIntelligence(...)
 * @param {Date} [opts.startedAt]
 */
export async function persistCompletedAudit(db, { clerkUserId, email = null, v2Payload, startedAt }) {
  if (!v2Payload?.byQuestion || !v2Payload.domain) {
    const err = new Error("Invalid audit payload.");
    err.code = "VALIDATION";
    throw err;
  }

  const workspace = await getOrCreateWorkspace(db, { clerkUserId, email });
  const website = await getOrCreateWebsite(db, {
    workspaceId: workspace.id,
    domain: String(v2Payload.domain).toLowerCase(),
    url: v2Payload.websiteUrl || `https://${v2Payload.domain}`,
    brandName: v2Payload.brand || null,
    category: v2Payload.category || null,
  });

  const questionTexts = (v2Payload.byQuestion || []).map((q) => q.query).filter(Boolean);
  const questionRows = await upsertBuyerQuestions(db, {
    websiteId: website.id,
    questions: questionTexts,
  });
  const questionByText = new Map(questionRows.map((q) => [q.question, q]));

  const intel = v2Payload.intelligence || {};
  const sov = intel.shareOfVoice || {};
  const providers = intel.providers || {};
  const agentic = intel.agenticScore || {};
  const storeAnswer = shouldStoreRawAnswers();

  const audit = await db.audit.create({
    data: {
      websiteId: website.id,
      status: "completed",
      startedAt: startedAt || new Date(),
      completedAt: new Date(),
      mentionShare: numOrNull(sov.mentionShare),
      recommendationShare: numOrNull(sov.recommendationShare),
      top3Share: numOrNull(sov.top3Share),
      providerMetrics: providers,
      foundScore: numOrNull(agentic.found?.score),
      foundStatus: agentic.found?.status || null,
      understoodScore: numOrNull(agentic.understood?.score),
      understoodStatus: agentic.understood?.status || null,
      recommendedScore: numOrNull(agentic.recommended?.score),
      recommendedStatus: agentic.recommended?.status || null,
      boughtScore: numOrNull(agentic.bought?.score),
      boughtStatus: agentic.bought?.status || null,
      overallScore: numOrNull(agentic.overall?.score),
      overallStatus: agentic.overall?.status || null,
      intelligenceSummary: {
        overall: intel.overall || null,
        perception: intel.perception
          ? {
              method: intel.perception.method,
              brandThemes: intel.perception.brandThemes,
              aiThemes: intel.perception.aiThemes,
              missingThemes: intel.perception.missingThemes,
              unexpectedThemes: intel.perception.unexpectedThemes,
            }
          : null,
        competitorGap: intel.competitors?.gap || null,
      },
      questions: {
        create: questionRows.map((q) => ({
          questionId: q.id,
          sortOrder: q.sortOrder,
        })),
      },
      aiTests: {
        create: flattenAiTests(v2Payload.byQuestion, questionByText, storeAnswer),
      },
      competitors: {
        create: (intel.competitors?.list || []).map((c) => ({
          name: String(c.name).slice(0, 120),
          mentions: c.mentions || 0,
          recommendations: c.recommendations || 0,
          top3: c.top3 || 0,
          averagePosition: numOrNull(c.averagePosition),
          mentionShare: numOrNull(c.mentionShare),
          recommendationShare: numOrNull(c.recommendationShare),
          top3Share: numOrNull(c.top3Share),
        })),
      },
      perception: intel.perception
        ? {
            create: {
              brandThemes: intel.perception.brandThemes || [],
              aiThemes: intel.perception.aiThemes || [],
              missingThemes: intel.perception.missingThemes || [],
              unexpectedThemes: intel.perception.unexpectedThemes || [],
              method: intel.perception.method || "deterministic_keywords",
            },
          }
        : undefined,
    },
    include: {
      competitors: true,
      perception: true,
      questions: { include: { question: true } },
      aiTests: true,
    },
  });

  return { workspace, website, audit, questionRows };
}

function flattenAiTests(byQuestion, questionByText, storeAnswer) {
  const rows = [];
  for (const row of byQuestion || []) {
    const qText = String(row.query || "");
    const qMeta = questionByText.get(qText);
    for (const p of row.providers || []) {
      if (!p) continue;
      rows.push({
        provider: String(p.provider || "unknown"),
        model: String(p.model || ""),
        question: qText,
        questionId: qMeta?.id || null,
        answer: storeAnswer && !p.error ? String(p.answer || "").slice(0, 20000) : null,
        storeAnswer: Boolean(storeAnswer),
        brandMentioned: Boolean(p.brandMentioned),
        recommended: Boolean(p.recommended),
        position: p.brandPosition != null && Number.isFinite(p.brandPosition) ? Math.trunc(p.brandPosition) : null,
        competitors: p.competitors || [],
        citations: p.citations || [],
        confidence: numOrNull(p.confidence),
        latencyMs: p.latencyMs != null ? Math.trunc(p.latencyMs) : null,
        error: p.error ? String(p.error).slice(0, 1000) : null,
      });
    }
  }
  return rows;
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Most recent completed audit for a website (excluding an optional id).
 * @param {import("@prisma/client").PrismaClient} db
 * @param {string} websiteId
 * @param {{ excludeAuditId?: string }} [opts]
 */
export async function getPreviousCompletedAudit(db, websiteId, opts = {}) {
  return db.audit.findFirst({
    where: {
      websiteId,
      status: "completed",
      ...(opts.excludeAuditId ? { id: { not: opts.excludeAuditId } } : {}),
    },
    orderBy: { completedAt: "desc" },
    include: {
      competitors: true,
      perception: true,
      aiTests: true,
      questions: { include: { question: true }, orderBy: { sortOrder: "asc" } },
    },
  });
}

/**
 * List audits for a Clerk user (own workspace only).
 */
export async function listAuditsForUser(db, { clerkUserId, websiteId, limit = 20 }) {
  return db.audit.findMany({
    where: {
      website: {
        workspace: { clerkUserId },
        ...(websiteId ? { id: websiteId } : {}),
      },
    },
    orderBy: { completedAt: "desc" },
    take: Math.min(50, Math.max(1, limit)),
    include: {
      website: { select: { id: true, domain: true, brandName: true, url: true } },
      competitors: { take: 5, orderBy: { mentions: "desc" } },
    },
  });
}
