/**
 * Shared Multi-AI visibility audit (v2). Used by POST /api/visibility/v2 and MCP run_visibility_audit.
 * Never reads plan/paid/quota from the client payload — callers pass server-side entitlements.
 */
import {
  validateStoreUrl as defaultValidateStoreUrl,
  siteSignals as defaultSiteSignals,
  identifyBrand as defaultIdentifyBrand,
  generateBuyerQueries as defaultGenerateBuyerQueries,
  runMultiAiAudit as defaultRunMultiAiAudit,
} from "./audit.js";
import { runAllProviders as defaultRunAllProviders } from "./run-provider.js";
import { buildIntelligence } from "./intelligence/index.js";
import {
  persistCompletedAudit as defaultPersistCompletedAudit,
  getPreviousCompletedAudit as defaultGetPreviousCompletedAudit,
} from "../db/persist.js";
import {
  preflightAudit,
  checkWebsiteSlots,
  reserveUsage as defaultReserveUsage,
  commitUsage as defaultCommitUsage,
  releaseUsage as defaultReleaseUsage,
  countBillableAiTests,
  getUsageSnapshot,
  upgradePayload,
} from "../billing/index.js";

export function buildSiteContext(sig, body = {}) {
  const commerce = body.commerceSignals && typeof body.commerceSignals === "object" ? body.commerceSignals : {};
  const scan = body.scanSignals && typeof body.scanSignals === "object" ? body.scanSignals : {};

  return {
    reachable: Boolean(sig?.ok),
    hasTitle: Boolean(sig?.title),
    hasDescription: Boolean(sig?.desc),
    hasH1: Boolean(sig?.h1),
    hasOg: Boolean(sig?.ogTitle || sig?.desc),
    bodyTextLength: sig?.bodyText ? String(sig.bodyText).length : 0,
    robotsAllowedRatio: typeof scan.robotsAllowedRatio === "number" ? scan.robotsAllowedRatio : undefined,
    hasSitemap: scan.hasSitemap === true ? true : undefined,
    hasProductSchema: scan.hasProductSchema === true ? true : undefined,
    hasAnySchema: scan.hasAnySchema === true ? true : undefined,
    hasLlms: scan.hasLlms === true ? true : undefined,
    jsLocked: scan.jsLocked === true ? true : undefined,
    isShopify: commerce.isShopify === true ? true : undefined,
    hasProductFeed: commerce.hasProductFeed === true ? true : undefined,
    hasOfferSchema: commerce.hasOfferSchema === true ? true : undefined,
    hasCheckoutSignals: commerce.hasCheckoutSignals === true ? true : undefined,
    hasAcp: commerce.hasAcp === true ? true : undefined,
    hasUcp: commerce.hasUcp === true ? true : undefined,
  };
}

export function withIntelligence(payload, siteContext, { advancedCompetitors = true } = {}) {
  const intelligence = buildIntelligence({
    brandName: payload.brand,
    byQuestion: payload.byQuestion || [],
    category: payload.category || "",
    whatTheySell: payload.whatTheySell || "",
    brandDescription: payload.whatTheySell || "",
    siteContext,
    buyerQuestions: (payload.byQuestion || []).map((r) => r.query).filter(Boolean),
  });

  if (!advancedCompetitors && intelligence?.competitors) {
    intelligence.competitors = {
      ...intelligence.competitors,
      advanced: false,
      top: (intelligence.competitors.top || []).slice(0, 3),
    };
  }

  return {
    ...payload,
    audit: {
      version: 2,
      domain: payload.domain,
      brand: payload.brand,
      category: payload.category,
      websiteUrl: payload.websiteUrl,
      queriesRun: payload.queriesRun,
    },
    intelligence,
  };
}

function fail(status, body) {
  return { ok: false, status, body };
}

/**
 * Run a v2 visibility audit (site signals → brand/questions → preflight → reserve → providers → commit/persist).
 *
 * @param {object} input server-assembled input (entitlements from billing, not the client)
 * @param {object} [deps] injectable collaborators for tests
 * @returns {Promise<{ ok: true, payload: object } | { ok: false, status: number, body: object }>}
 */
export async function runVisibilityAuditV2(input = {}, deps = {}) {
  const startedAt = input.startedAt instanceof Date ? input.startedAt : new Date();
  const plan = input.entitlements;
  const prisma = input.prisma || null;
  const workspace = input.workspace || null;

  const validateStoreUrl = deps.validateStoreUrl || defaultValidateStoreUrl;
  const siteSignals = deps.siteSignals || defaultSiteSignals;
  const identifyBrand = deps.identifyBrand || defaultIdentifyBrand;
  const generateBuyerQueries = deps.generateBuyerQueries || defaultGenerateBuyerQueries;
  const runAllProviders = deps.runAllProviders || defaultRunAllProviders;
  const runMultiAiAudit = deps.runMultiAiAudit || defaultRunMultiAiAudit;
  const persistCompletedAudit = deps.persistCompletedAudit || defaultPersistCompletedAudit;
  const getPreviousCompletedAudit = deps.getPreviousCompletedAudit || defaultGetPreviousCompletedAudit;
  const reserveUsage = deps.reserveUsage || defaultReserveUsage;
  const commitUsage = deps.commitUsage || defaultCommitUsage;
  const releaseUsage = deps.releaseUsage || defaultReleaseUsage;

  const validated = validateStoreUrl(input.url);
  if (!validated.ok) return fail(422, { error: validated.error });

  const { domain, href: websiteUrl } = validated;

  if (prisma && workspace) {
    const existingSite = await prisma.website.findUnique({
      where: {
        workspaceId_domain: { workspaceId: workspace.id, domain },
      },
    });
    if (!existingSite) {
      let websiteCount = workspace._count?.websites;
      if (websiteCount == null && typeof prisma.website?.count === "function") {
        websiteCount = await prisma.website.count({ where: { workspaceId: workspace.id } });
      }
      const slot = checkWebsiteSlots({
        entitlements: plan,
        websiteCount: websiteCount ?? 0,
      });
      if (!slot.ok) return fail(402, slot.upgrade);
    }
  }

  const brandOverride = input.brand ? String(input.brand).trim().slice(0, 80) : "";
  let brandName = brandOverride || domain.split(".")[0];
  let category = "";
  let whatTheySell = "";
  let isEcommerce = true;
  let sig = { ok: false };

  const maxQ = plan?.entitlements?.buyerQuestions ?? 5;
  const qCap = maxQ == null || maxQ === -1 ? 50 : maxQ;

  const singleQ = input.question ? String(input.question).trim().slice(0, 300) : "";
  let questions = Array.isArray(input.questions)
    ? input.questions.map((q) => String(q).trim().slice(0, 300)).filter(Boolean).slice(0, qCap)
    : singleQ
      ? [singleQ]
      : [];

  sig = await siteSignals(websiteUrl);

  if (!brandOverride || !questions.length) {
    const contentBlob = sig.ok
      ? `Title: ${sig.title}\nOG Title: ${sig.ogTitle}\nDescription: ${sig.desc}\nH1: ${sig.h1}\nPage text: ${sig.bodyText}`
      : `(could not fetch site; only the domain is known: ${domain})`;
    const info = await identifyBrand({ domain, contentBlob, brandOverride });
    brandName = info.brand;
    category = info.category || "";
    whatTheySell = info.whatTheySell || "";
    isEcommerce = info.isEcommerce !== false;
    if (!questions.length) {
      questions = await generateBuyerQueries({
        brand: brandName,
        category,
        whatTheySell,
        isEcommerce,
      });
      questions = questions.slice(0, qCap);
    }
  }

  let usage = input.usage || { aiTests: 0, audits: 0, monitoringRuns: 0 };
  if (prisma && workspace?.id && typeof getUsageSnapshot === "function") {
    try {
      usage = await getUsageSnapshot(prisma, workspace.id, input.now);
    } catch {
      /* keep caller snapshot */
    }
  }

  const usageForFlight = {
    ...usage,
    aiTests: usage?.aiTestsEffective ?? usage?.aiTests ?? 0,
  };
  const flight = preflightAudit({
    entitlements: plan,
    usage: usageForFlight,
    questionCount: questions.length,
    providerCount: 3,
  });
  if (!flight.ok) {
    if (flight.upgrade?.feature === "aiTests") {
      const used = Number(usageForFlight.aiTests) || 0;
      const limit = plan?.entitlements?.aiTestsPerMonth;
      const remaining = limit == null || limit === -1 ? null : Math.max(0, Number(limit) - used);
      return fail(402, { ...flight.upgrade, expectedAiTests: flight.expectedAiTests, remaining });
    }
    return fail(402, flight.upgrade);
  }

  let reservedAiTests = 0;
  if (prisma && workspace?.id) {
    const reserved = await reserveUsage(prisma, workspace.id, {
      aiTests: flight.expectedAiTests,
      limit: plan?.entitlements?.aiTestsPerMonth,
    });
    if (!reserved.ok) {
      return fail(
        402,
        upgradePayload({
          planId: plan?.planId,
          feature: "aiTests",
          used: reserved.used,
          limit: reserved.limit,
          message: "Insufficient AI test allowance (including in-flight audits).",
        })
      );
    }
    reservedAiTests = reserved.reserved;
  }

  const siteContext = buildSiteContext(sig, input);
  const advancedCompetitors = plan?.entitlements?.advancedCompetitors === true;

  let responsePayload;
  try {
    if (questions.length === 1 && (brandOverride || singleQ)) {
      const providers = await runAllProviders({
        brandName,
        websiteUrl,
        buyerQuestion: questions[0],
        domain,
        category,
      });
      const payload = {
        version: 2,
        domain,
        brand: brandName,
        category,
        whatTheySell,
        isEcommerce,
        websiteUrl,
        queriesRun: 1,
        byQuestion: [{ query: questions[0], providers }],
        providers,
      };
      responsePayload = withIntelligence(payload, siteContext, { advancedCompetitors });
    } else {
      const auditRun = await runMultiAiAudit({
        brandName,
        websiteUrl,
        domain,
        questions,
        category,
      });
      const payload = {
        version: 2,
        whatTheySell,
        isEcommerce,
        ...auditRun,
      };
      responsePayload = withIntelligence(payload, siteContext, { advancedCompetitors });
    }
  } catch {
    if (prisma && workspace?.id && reservedAiTests > 0) {
      await releaseUsage(prisma, workspace.id, { reservedAiTests }).catch(() => {});
    }
    return fail(500, { error: "Multi-AI visibility check failed. Try again." });
  }

  const billable = countBillableAiTests(responsePayload);
  if (prisma && workspace?.id) {
    try {
      await commitUsage(prisma, workspace.id, {
        reservedAiTests,
        actualAiTests: billable,
        audits: 1,
      });
    } catch (e) {
      console.error("usage commit failed:", e?.message || e);
    }
  }

  const persistence = {
    saved: false,
    auditId: null,
    websiteId: null,
    previousAuditId: null,
  };

  if (!prisma || !input.clerkUserId) {
    persistence.skipped = true;
    persistence.reason = "database_not_configured";
  } else {
    try {
      const saved = await persistCompletedAudit(prisma, {
        clerkUserId: input.clerkUserId,
        email: input.email || null,
        v2Payload: responsePayload,
        startedAt,
      });
      const previous = await getPreviousCompletedAudit(prisma, saved.website.id, {
        excludeAuditId: saved.audit.id,
      });
      persistence.saved = true;
      persistence.auditId = saved.audit.id;
      persistence.websiteId = saved.website.id;
      persistence.previousAuditId = previous?.id || null;
    } catch (e) {
      console.error("visibility v2 persist error:", e?.message || e);
      persistence.saved = false;
      persistence.error = "persist_failed";
    }
  }

  responsePayload.persistence = persistence;
  responsePayload.usage = {
    aiTestsCharged: billable,
    expectedAiTests: flight.expectedAiTests,
  };
  if (persistence.auditId) {
    responsePayload.audit = {
      ...responsePayload.audit,
      id: persistence.auditId,
      websiteId: persistence.websiteId,
      previousAuditId: persistence.previousAuditId,
    };
  }

  return { ok: true, payload: responsePayload };
}
