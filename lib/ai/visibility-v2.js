/**
 * Shared Multi-AI visibility audit (v2). Used by POST /api/visibility/v2 and MCP run_visibility_audit.
 * Never reads plan/paid/quota from the client payload Ã¢â‚¬â€ callers pass server-side entitlements.
 */
import {
  validateStoreUrl as defaultValidateStoreUrl,
  siteSignals as defaultSiteSignals,
  identifyBrand as defaultIdentifyBrand,
  generateBuyerQueries as defaultGenerateBuyerQueries,
  runMultiAiAudit as defaultRunMultiAiAudit,
} from "./audit.js";
import { runAllProviders as defaultRunAllProviders } from "./run-provider.js";
import { allProvidersFailed } from "../monitoring/run.js";
import { budgetAuthorizationCode, readProviderBudgetConfig, openProviderScanBudget, providerBudgetStorage } from "./provider-budget.js";
import { buildIntelligence } from "./intelligence/index.js";
import {
  reserveUsageOperation as defaultReserveUsageOperation,
  commitUsageOperation as defaultCommitUsageOperation,
  commitUsageOperationInTransaction as defaultCommitUsageOperationInTransaction,
  releaseUsageOperation as defaultReleaseUsageOperation,
  getUsageOperationStatus as defaultGetUsageOperationStatus,
} from "../billing/usage-operations.js";
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

function providerDiagnostics(byQuestion) {
  const rows = [];
  for (const row of byQuestion || []) {
    for (const provider of row?.providers || []) {
      if (!provider?.error) continue;
      rows.push({
        provider: String(provider.provider || "unknown").slice(0, 40),
        question: String(row.query || provider.question || "").slice(0, 160),
        error: publicProviderError(provider.error),
      });
      if (rows.length >= 20) return rows;
    }
  }
  return rows;
}

function publicProviderError(error) {
  return String(error || "Provider failed")
    .slice(0, 180)
    .replace(/sk_(live|test)_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/AIza[0-9A-Za-z\-_]{10,}/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

export function buildSiteContext(sig) {
  return {
    reachable: Boolean(sig?.ok),
    hasTitle: Boolean(sig?.title),
    hasDescription: Boolean(sig?.desc),
    hasH1: Boolean(sig?.h1),
    hasOg: Boolean(sig?.ogTitle || sig?.desc),
    bodyTextLength: sig?.bodyText
      ? String(sig.bodyText).length
      : 0,

    // These signals are not yet verified by the server scanner.
    robotsAllowedRatio: undefined,
    hasSitemap: undefined,
    hasProductSchema: undefined,
    hasAnySchema: undefined,
    hasLlms: undefined,
    jsLocked: undefined,
    isShopify: undefined,
    hasProductFeed: undefined,
    hasOfferSchema: undefined,
    hasCheckoutSignals: undefined,
    hasAcp: undefined,
    hasUcp: undefined,
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

function budgetStop(error, usage = {}) {
  const code = budgetAuthorizationCode(error);
  if (!code) return null;
  return fail(503, {
    error: code,
    persistence: { saved: false, auditId: null, websiteId: null, previousAuditId: null },
    usage: { aiTestsCharged: 0, ...usage },
  });
}

/**
 * Run a v2 visibility audit (site signals Ã¢â€ â€™ brand/questions Ã¢â€ â€™ preflight Ã¢â€ â€™ reserve Ã¢â€ â€™ providers Ã¢â€ â€™ commit/persist).
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
  const reserveUsageOperation = deps.reserveUsageOperation || defaultReserveUsageOperation;
  const commitUsageOperation = deps.commitUsageOperation || defaultCommitUsageOperation;
  const commitUsageOperationInTransaction = deps.commitUsageOperationInTransaction || defaultCommitUsageOperationInTransaction;
  const releaseUsageOperation = deps.releaseUsageOperation || defaultReleaseUsageOperation;
  const getUsageOperationStatus = deps.getUsageOperationStatus || defaultGetUsageOperationStatus;

  // Reject mismatched Clerk identity before website, provider, or billing work.
  if (
    workspace?.id &&
    (!input.clerkUserId ||
      !workspace.clerkUserId ||
      workspace.clerkUserId !== input.clerkUserId)
  ) {
    return fail(403, { error: "workspace_identity_mismatch" });
  }
  // Verify workspace ownership against the database before side effects.
  if (workspace?.id) {
    if (typeof prisma?.workspace?.findFirst !== "function") {
      return fail(503, { error: "workspace_verification_unavailable" });
    }

    let ownedWorkspace;
    try {
      ownedWorkspace = await prisma.workspace.findFirst({
        where: {
          id: workspace.id,
          clerkUserId: input.clerkUserId,
        },
        select: { id: true },
      });
    } catch {
      return fail(503, { error: "workspace_verification_unavailable" });
    }

    if (!ownedWorkspace) {
      return fail(403, { error: "workspace_identity_mismatch" });
    }
  }
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
  if (!sig?.ok) {
    return fail(422, {
      error: "Couldn't reach that website. Check the URL and try again.",
    });
  }

  const budgetConfig = readProviderBudgetConfig();
  if (!budgetConfig.ok) {
    return fail(503, { error: "provider_budget_unverified" });
  }
  let budgetState = null;
  if (budgetConfig.enabled) {
    const opened = await openProviderScanBudget(prisma, budgetConfig);
    if (!opened.ok) {
      return fail(503, { error: opened.reason || "provider_budget_unverified" });
    }
    budgetState = opened.state;
  }
  const inBudget = (fn) => (budgetState ? providerBudgetStorage.run(budgetState, fn) : fn());

  if (!brandOverride || !questions.length) {
    const contentBlob = `Title: ${sig.title}\nOG Title: ${sig.ogTitle}\nDescription: ${sig.desc}\nH1: ${sig.h1}\nPage text: ${sig.bodyText}`;
    let info;
    try {
      info = await inBudget(() => identifyBrand({ domain, contentBlob, brandOverride }));
    } catch (error) {
      const stopped = budgetStop(error);
      if (stopped) return stopped;
      throw error;
    }
    brandName = info.brand;
    category = info.category || "";
    whatTheySell = info.whatTheySell || "";
    isEcommerce = info.isEcommerce !== false;
    if (!questions.length) {
      try {
        questions = await inBudget(() => generateBuyerQueries({
          brand: brandName,
          category,
          whatTheySell,
          isEcommerce,
        }));
      } catch (error) {
        const stopped = budgetStop(error);
        if (stopped) return stopped;
        throw error;
      }
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

  // A scan must use one billing protocol throughout its lifecycle.
  // Legacy injected mocks remain supported until their tests migrate.
  const hasLegacyMocks =
    typeof deps.reserveUsage === "function" &&
    typeof deps.commitUsage === "function";
  const hasOperationMocks =
    typeof deps.reserveUsageOperation === "function" ||
    typeof deps.commitUsageOperation === "function" ||
    typeof deps.releaseUsageOperation === "function";
  const useLegacyBilling = hasLegacyMocks && !hasOperationMocks;
  let billingOperationId = null;
  let reservedAiTests = 0;
  if (prisma && workspace?.id) {
    const reserved = useLegacyBilling
      ? await reserveUsage(prisma, workspace.id, {
          aiTests: flight.expectedAiTests,
          limit: plan?.entitlements?.aiTestsPerMonth,
        })
      : await reserveUsageOperation(prisma, workspace.id, {
          aiTests: flight.expectedAiTests,
          limit: plan?.entitlements?.aiTestsPerMonth,
          createOperationForZeroUsage: true,
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
    if (!useLegacyBilling) {
      billingOperationId = reserved.operationId;
      if (!billingOperationId) {
        return fail(500, {
          error: "billing_reservation_invalid",
          retryable: false,
        });
      }
    }
  }

  const siteContext = buildSiteContext(sig, input);
  const advancedCompetitors = plan?.entitlements?.advancedCompetitors === true;

  async function releaseHeldReservation() {
    if (!prisma || !workspace?.id) return "not_reserved";
    try {
      if (useLegacyBilling) {
        if (reservedAiTests <= 0) return "not_reserved";
        await releaseUsage(prisma, workspace.id, { reservedAiTests });
        return "released";
      }
      if (!billingOperationId) return "not_reserved";
      const released = await releaseUsageOperation(prisma, workspace.id, {
        operationId: billingOperationId,
      });
      return released?.settled === true ? "released" : "unconfirmed";
    } catch (error) {
      console.error("usage release failed:", error?.message || error);
      return "unconfirmed";
    }
  }

  let responsePayload;
  try {
    if (questions.length === 1 && (brandOverride || singleQ)) {
      const providers = await inBudget(() => runAllProviders({
        brandName,
        websiteUrl,
        buyerQuestion: questions[0],
        domain,
        category,
      }));
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
      const auditRun = await inBudget(() => runMultiAiAudit({
        brandName,
        websiteUrl,
        domain,
        questions,
        category,
      }));
      const payload = {
        version: 2,
        whatTheySell,
        isEcommerce,
        ...auditRun,
      };
      responsePayload = withIntelligence(payload, siteContext, { advancedCompetitors });
    }
  } catch (error) {
    const billingStatus = await releaseHeldReservation();
    const stopped = budgetStop(error, { billingStatus });
    if (stopped) return stopped;
    if (billingStatus === "unconfirmed") {
      return fail(500, {
        error: "billing_release_unconfirmed",
        retryable: false,
        usage: { billingStatus, aiTestsCharged: null },
      });
    }
    return fail(500, { error: "Multi-AI visibility check failed. Try again." });
  }

  if (allProvidersFailed(responsePayload.byQuestion)) {
    const billingStatus = await releaseHeldReservation();
    if (billingStatus === "unconfirmed") {
      return fail(500, {
        error: "billing_release_unconfirmed",
        retryable: false,
        usage: { billingStatus, aiTestsCharged: null },
      });
    }
    return fail(503, {
      error: "ai_measurement_unavailable",
      message: "Every AI provider failed, so no visibility score was saved.",
      persistence: { saved: false, auditId: null, websiteId: null, previousAuditId: null },
      usage: {
        billingStatus,
        aiTestsCharged: 0,
        expectedAiTests: flight.expectedAiTests,
      },
      providerErrors: providerDiagnostics(responsePayload.byQuestion),
    });
  }

  const billable = countBillableAiTests(responsePayload);
  const persistence = {
    saved: false,
    auditId: null,
    websiteId: null,
    previousAuditId: null,
  };

  const saveReport = async (db) => {
    const saved = await persistCompletedAudit(db, {
      clerkUserId: input.clerkUserId,
      email: input.email || null,
      v2Payload: responsePayload,
      startedAt,
    });
    const previous = await getPreviousCompletedAudit(db, saved.website.id, {
      excludeAuditId: saved.audit.id,
    });
    return {
      saved: true,
      auditId: saved.audit.id,
      websiteId: saved.website.id,
      previousAuditId: previous?.id || null,
    };
  };

  const reconcileAtomicBilling = async () => {
    if (!billingOperationId) return "unconfirmed";
    let billingStatus = "unconfirmed";
    try {
      const status = await getUsageOperationStatus(
        prisma, workspace.id, billingOperationId
      );
      if (status === "reserved") {
        const released = await releaseUsageOperation(
          prisma, workspace.id, { operationId: billingOperationId }
        );
        if (released?.settled === true) {
          billingStatus = "released";
        } else {
          const latest = await getUsageOperationStatus(
            prisma, workspace.id, billingOperationId
          );
          billingStatus = latest === "committed" ? "committed"
            : latest === "released" ? "released" : "unconfirmed";
        }
      } else if (status === "committed" || status === "released") {
        billingStatus = status;
      }
    } catch (reconcileError) {
      console.error(
        "atomic billing reconciliation failed:",
        reconcileError?.message || reconcileError
      );
    }
    return billingStatus;
  };

  if (prisma && workspace?.id && !useLegacyBilling) {
    if (!input.clerkUserId || !billingOperationId ||
        typeof prisma.$transaction !== "function") {
      const billingStatus = await reconcileAtomicBilling();
      return fail(500, {
        error: "atomic_settlement_unavailable",
        retryable: false,
        usage: { billingStatus, aiTestsCharged: null },
      });
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const saved = await saveReport(tx);
        const settlement = await commitUsageOperationInTransaction(
          tx,
          workspace.id,
          {
            operationId: billingOperationId,
            actualAiTests: billable,
            audits: 1,
          }
        );
        if (settlement?.settled !== true) {
          throw new Error("Atomic billing settlement not confirmed");
        }
        return saved;
      });
      Object.assign(persistence, result);
    } catch (e) {
      console.error("atomic audit settlement failed:", e?.message || e);
      const billingStatus = await reconcileAtomicBilling();
      return fail(500, {
        error: "atomic_settlement_failed",
        retryable: false,
        message: "Audit persistence and billing settlement could not be confirmed. Do not retry automatically.",
        usage: { billingStatus, aiTestsCharged: null },
      });
    }
  } else {
    if (prisma && workspace?.id && useLegacyBilling) {
      try {
        await commitUsage(prisma, workspace.id, {
          reservedAiTests,
          actualAiTests: billable,
          audits: 1,
        });
      } catch (e) {
        console.error("legacy usage commit failed:", e?.message || e);
        return fail(500, {
          error: "billing_commit_failed",
          retryable: false,
          usage: { billingStatus: "unconfirmed", aiTestsCharged: null },
        });
      }
    }

    if (!prisma || !input.clerkUserId) {
      persistence.skipped = true;
      persistence.reason = "database_not_configured";
    } else {
      try {
        Object.assign(persistence, await saveReport(prisma));
      } catch (e) {
        console.error("visibility v2 persist error:", e?.message || e);
        persistence.error = "persist_failed";
      }
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

  if (persistence.error === "persist_failed") {
    return fail(500, {
      error: "persist_failed",
      retryable: false,
      message: "Audit completed, but the report could not be saved. AI usage may already have been charged. Do not retry automatically.",
      persistence,
      usage: responsePayload.usage,
    });
  }

  return { ok: true, payload: responsePayload };
}
