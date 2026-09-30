#!/usr/bin/env node
/**
 * Growth qualification eval harness.
 *
 * Offline (default, ZERO model calls):
 *   npm run growth
 *
 * Live (opt-in, hard ceiling 20 calls):
 *   GROWTH_EVAL_LIVE=1 npm run growth
 *
 * Does not run under npm test.
 */

import fs from "node:fs";
import path from "node:path";
import { EVAL_CASES, SAMPLE_PRODUCT_PROFILE } from "./fixtures.js";
import { scoreZeroTolerance, citationsUsed, flattenQualificationText } from "./metrics.js";
import { runQualificationPipeline, applyCriticPolicy, reviewQualification } from "../qualification-critic.js";
import { GROWTH_REASONING_MODEL, GROWTH_REASONING_TEMPERATURE, GROWTH_REASONING_MAX_TOKENS, qualifyProspect } from "../qualification-reasoner.js";
import { QUALIFICATION_JSON_SCHEMA_FORMAT, QUALIFICATION_JSON_OBJECT_FORMAT } from "../qualification-schema.js";
import { getAicreditsConfig, aicreditsChatDetailed } from "../../ai/aicredits.js";

export const LIVE_CALL_CEILING = 20;
export const PHASE_2D_FULL_CEILING = 18;
export const PHASE_2E_CEILING = 22;
export const DIAGNOSTIC_CASE_IDS = ["woo_subscriptions_payments", "missing_evidence", "injection_text"];

export const CORRUPT_CASES = [
  {
    id: "corrupt_abandoned_revenue",
    packId: "woo_thin_signals",
    qualification: {
      decision: "strong_fit",
      summary: "Huge opportunity.",
      reasons: [
        {
          type: "observation",
          statement: "This store loses $50,000/month from abandoned carts.",
          evidenceIds: [],
        },
      ],
      uncertainties: [],
    },
  },
  {
    id: "corrupt_woo_when_inconclusive",
    packId: "platform_inconclusive",
    qualification: {
      decision: "strong_fit",
      summary: "Platform is clear.",
      reasons: [
        {
          type: "observation",
          statement: "This is definitely WooCommerce.",
          evidenceIds: [],
        },
      ],
      uncertainties: [],
    },
  },
  {
    id: "corrupt_email_is_fit",
    packId: "contact_is_not_fit",
    qualification: {
      decision: "strong_fit",
      summary: "They published an email.",
      reasons: [
        {
          type: "inference",
          statement: "Because the contact email is public, this is a strong fit.",
          evidenceIds: [],
        },
      ],
      uncertainties: [],
    },
  },
  {
    id: "corrupt_product_copy_as_prospect",
    packId: "product_copy_not_prospect",
    qualification: {
      decision: "strong_fit",
      summary: "They already have our channel.",
      reasons: [
        {
          type: "observation",
          statement: "The product offers WhatsApp recovery, therefore this prospect already uses WhatsApp recovery.",
          evidenceIds: [],
        },
      ],
      uncertainties: [],
    },
  },
];

function loadLocalEnv() {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(process.cwd(), name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] == null || process.env[key] === "") process.env[key] = val;
    }
  }
}

function caseById(id) {
  return EVAL_CASES.find((c) => c.id === id);
}

export function createBudgetedChat({ maxCalls, onCall }) {
  let remaining = maxCalls;
  let calls = 0;
  const forwarded = [];
  const usageLog = [];

  const chatFn = async (model, messages, opts = {}) => {
    if (remaining <= 0) {
      const err = new Error("EVAL_BUDGET_EXCEEDED");
      err.code = "EVAL_BUDGET_EXCEEDED";
      throw err;
    }
    remaining -= 1;
    calls += 1;
    forwarded.push({
      model,
      temperature: opts.temperature,
      max_tokens: opts.max_tokens,
    });
    if (onCall) onCall({ remaining, calls, opts });
    const detailed = await aicreditsChatDetailed(model, messages, opts);
    usageLog.push({
      prompt_tokens: detailed.usage?.prompt_tokens ?? null,
      completion_tokens: detailed.usage?.completion_tokens ?? null,
      total_tokens: detailed.usage?.total_tokens ?? null,
    });
    return detailed.content;
  };

  return {
    chatFn,
    stats: () => ({ calls, remaining, forwarded, usageLog }),
  };
}

function judgePipelineCase(c, out) {
  const q = out.qualification;
  const zt = scoreZeroTolerance(q, c.pack, c.productProfile);
  const ztFail =
    zt.unknownEvidenceIds +
      zt.inventedContacts +
      zt.injectionCompliance +
      zt.abandonedOrRevenue +
      zt.platformHallucination +
      zt.productCopyAttributed >
    0;
  const bandOk = !q || c.expectedBand.includes(q.decision);
  const shortOk = !c.shortCircuit || (out.llmCalls === 0 && q?.decision === "not_fit");
  const grounded = (q?.reasons || []).every((r) => (r.evidenceIds || []).length > 0) || q?.decision === "insufficient_evidence";
  const acceptUngrounded =
    out.status === "accept" && !out.reasoner?.shortCircuited && !((q?.reasons || []).some((r) => (r.evidenceIds || []).length > 0));
  const pass = !ztFail && bandOk && shortOk && out.status !== "failed" && !acceptUngrounded;
  return { zt, bandOk, shortOk, grounded, pass, ztFail };
}

function selectedCases() {
  const raw = String(process.env.GROWTH_EVAL_ONLY || "").trim();
  if (!raw) return EVAL_CASES;
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return EVAL_CASES.filter((c) => ids.includes(c.id));
}

function selectedCorruptCases() {
  if (String(process.env.GROWTH_EVAL_ONLY || "").trim()) return [];
  return CORRUPT_CASES;
}

function resolvedCeiling() {
  const n = Number(process.env.GROWTH_EVAL_MAX_CALLS);
  if (Number.isFinite(n) && n > 0) return Math.min(LIVE_CALL_CEILING, Math.floor(n));
  return LIVE_CALL_CEILING;
}

export async function runLiveEval({ chatFn, getStats, maxCalls, cases, corruptCases, responseFormat, maxAttempts }) {
  const pipeline = [];
  let stopped = false;
  const runCases = cases || EVAL_CASES;
  const runCorrupt = corruptCases || CORRUPT_CASES;

  for (const c of runCases) {
    if (getStats().remaining <= 0 && !c.shortCircuit) {
      stopped = true;
      pipeline.push({ id: c.id, pass: false, reason: "stopped_budget", calls: 0 });
      break;
    }
    const out = await runQualificationPipeline({
      pack: c.pack,
      productProfile: c.productProfile,
      chatFn,
      responseFormat,
      maxAttempts: maxAttempts ?? 1,
    });
    const judged = judgePipelineCase(c, out);
    const q = out.qualification;
    pipeline.push({
      id: c.id,
      decision: q?.decision || null,
      critic: out.critic?.verdict || (out.critic?.skipped ? "skipped" : null),
      criticPolicy: out.critic?.policy?.verdict || null,
      criticLlm: out.critic?.llmReview?.verdict || null,
      criticSkipped: Boolean(out.critic?.skipped),
      final: out.status,
      calls: out.llmCalls,
      reasonerAttempts: out.reasoner?.usage?.attempts || 0,
      firstRawOk: out.reasoner?.usage?.contract?.firstRawOk ?? null,
      firstNormalizedOk: out.reasoner?.usage?.contract?.firstNormalizedOk ?? null,
      retryUsed: Boolean(out.reasoner?.usage?.contract?.retryUsed),
      unknownBefore: out.reasoner?.usage?.contract?.unknownBefore || [],
      unknownAfter: out.reasoner?.usage?.contract?.unknownAfter || [],
      reasonerCalls: out.reasoner?.usage?.llmCalls || 0,
      criticCalls: out.critic?.usage?.llmCalls || 0,
      structuralOk: Boolean(out.reasoner?.ok),
      shortCircuited: Boolean(out.reasoner?.shortCircuited),
      citations: citationsUsed(q),
      groundedReasonCount: (q?.reasons || []).filter((r) => (r.evidenceIds || []).length > 0).length,
      invariantBlocked: Boolean(out.groundingInvariant?.blocked),
      summary: q?.summary || null,
      zt: judged.zt,
      pass: judged.pass,
      reason: judged.pass
        ? judged.grounded
          ? "grounded_and_in_band"
          : "in_band_but_review"
        : judged.ztFail
          ? "zero_tolerance"
          : !judged.bandOk
            ? `decision ${q?.decision} outside ${c.expectedBand.join("|")}`
            : out.status,
      observationInference: (q?.reasons || []).map((r) => r.type),
      reasonerErrors: out.reasoner?.errors || (out.reasoner?.error ? [out.reasoner.error] : []),
    });
  }

  const criticProbe = [];
  let policyCatch = 0;
  let llmOnly = 0;
  let missed = 0;

  for (const corrupt of runCorrupt) {
    const host = caseById(corrupt.packId);
    const packedQ = corrupt.qualification;
    const policy = applyCriticPolicy(host.pack, host.productProfile, packedQ);
    const policyCaught = policy.verdict === "fail" || policy.verdict === "needs_review";
    let llmVerdict = null;
    let source = "policy";
    if (policyCaught) {
      policyCatch += 1;
    } else if (getStats().remaining > 0) {
      const reviewed = await reviewQualification({
        pack: host.pack,
        productProfile: host.productProfile,
        qualification: packedQ,
        chatFn,
        retryInvalidJson: false,
      });
      llmVerdict = reviewed.verdict;
      if (reviewed.verdict === "fail" || reviewed.verdict === "needs_review") {
        llmOnly += 1;
        source = "llm_only";
      } else {
        missed += 1;
        source = "missed";
      }
    } else {
      missed += 1;
      source = "missed_budget";
      stopped = true;
    }
    criticProbe.push({
      id: corrupt.id,
      policyVerdict: policy.verdict,
      llmVerdict,
      source,
    });
  }

  const ztTotals = pipeline.reduce(
    (acc, row) => {
      if (!row.zt) return acc;
      acc.unknownEvidenceIds += row.zt.unknownEvidenceIds;
      acc.inventedContacts += row.zt.inventedContacts;
      acc.injectionCompliance += row.zt.injectionCompliance;
      acc.abandonedOrRevenue += row.zt.abandonedOrRevenue;
      acc.platformHallucination += row.zt.platformHallucination;
      acc.productCopyAttributed += row.zt.productCopyAttributed;
      return acc;
    },
    {
      unknownEvidenceIds: 0,
      inventedContacts: 0,
      injectionCompliance: 0,
      abandonedOrRevenue: 0,
      platformHallucination: 0,
      productCopyAttributed: 0,
    }
  );

  const nd = pipeline.filter((p) => !p.shortCircuited);
  const ndCount = nd.length;
  const firstRawValid = nd.filter((p) => p.firstRawOk === true).length;
  const firstNormalizedValid = nd.filter((p) => p.firstNormalizedOk === true).length;
  const retryRecovery = nd.filter((p) => p.retryUsed && p.structuralOk).length;
  const structuralFail = pipeline.filter((p) => p.structuralOk === false).length;
  const usageTotals = (getStats().usageLog || []).reduce(
    (acc, u) => {
      acc.prompt += Number(u.prompt_tokens) || 0;
      acc.completion += Number(u.completion_tokens) || 0;
      acc.total += Number(u.total_tokens) || 0;
      return acc;
    },
    { prompt: 0, completion: 0, total: 0 }
  );
  const successful = pipeline.filter((p) => p.structuralOk && !p.shortCircuited);
  const successfulCalls = successful.reduce((n, p) => n + (p.calls || 0), 0);

  return {
    model: GROWTH_REASONING_MODEL,
    temperature: GROWTH_REASONING_TEMPERATURE,
    max_tokens: GROWTH_REASONING_MAX_TOKENS,
    ceiling: maxCalls,
    adapter: getStats().forwarded,
    usage: getStats().usageLog,
    totalCalls: getStats().calls,
    stopped,
    pipeline,
    criticProbe,
    criticEffectiveness: { policyCatch, llmOnly, missed },
    contractReliability: {
      nonDeterministic: ndCount,
      firstRawValid,
      firstRawPct: ndCount ? Math.round((100 * firstRawValid) / ndCount) : 0,
      firstNormalizedValid,
      firstNormalizedPct: ndCount ? Math.round((100 * firstNormalizedValid) / ndCount) : 0,
      retryRecovery,
      structuralFailures: structuralFail,
      afterRetryValid: nd.filter((p) => p.structuralOk).length,
      afterRetryPct: ndCount ? Math.round((100 * nd.filter((p) => p.structuralOk).length) / ndCount) : 0,
    },
    tokenTotals: usageTotals,
    spend: {
      successfulQualifications: successful.length,
      callsPerSuccessful: successful.length ? successfulCalls / successful.length : null,
      tokensPerSuccessful: successful.length ? usageTotals.total / successful.length : null,
    },
    aggregates: {
      totalModelCalls: getStats().calls,
      structuralFailures: structuralFail,
      criticFail: pipeline.filter((p) => p.critic === "fail").length,
      needsReview: pipeline.filter((p) => p.final === "needs_review").length,
      accepted: pipeline.filter((p) => p.final === "accept").length,
      rejected: pipeline.filter((p) => p.final === "reject").length,
      failed: pipeline.filter((p) => p.final === "failed").length,
      zeroTolerance: ztTotals,
      zeroReasonAcceptBlocked: pipeline.filter((p) => p.invariantBlocked).length,
    },
    grounding: computeGroundingStats(pipeline),
  };
}

function computeGroundingStats(pipeline) {
  const nd = pipeline.filter((p) => p.structuralOk && !p.shortCircuited);
  const fit = nd.filter((p) => ["strong_fit", "possible_fit", "weak_fit", "not_fit"].includes(p.decision));
  const fitGrounded = fit.filter((p) => (p.groundedReasonCount || 0) >= 1);
  const cited = nd.map((p) => p.groundedReasonCount || 0);
  const avg = cited.length ? cited.reduce((a, b) => a + b, 0) / cited.length : 0;
  const groundedReasons = nd.reduce((n, p) => n + (p.groundedReasonCount || 0), 0);
  const citationCount = nd.reduce((n, p) => n + (p.citations || []).length, 0);
  const unknownBefore = nd.reduce((n, p) => n + (p.unknownBefore || []).length, 0);
  const unknownAfter = nd.reduce((n, p) => n + (p.unknownAfter || []).length, 0);
  const zeroReason = nd.filter((p) => (p.groundedReasonCount || 0) === 0).length;
  return {
    fitDecisions: fit.length,
    fitWithGroundedReason: fitGrounded.length,
    fitWithGroundedPct: fit.length ? Math.round((100 * fitGrounded.length) / fit.length) : 0,
    avgRetainedCitedReasons: Number(avg.toFixed(2)),
    avgEvidenceIdsPerGroundedReason: groundedReasons ? Number((citationCount / groundedReasons).toFixed(2)) : 0,
    unknownIdsBeforeNormalization: unknownBefore,
    unknownIdsAfterNormalization: unknownAfter,
    zeroReasonResults: zeroReason,
    unknownEvidenceIds: nd.reduce((n, p) => n + (p.zt?.unknownEvidenceIds || 0), 0),
  };
}

export async function probeStructuredOutput() {
  const pingSchema = {
    type: "json_schema",
    json_schema: {
      name: "ping",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "boolean" } },
      },
    },
  };
  const messages = [
    { role: "system", content: "Return only JSON." },
    { role: "user", content: "Set ok to true." },
  ];
  try {
    const detailed = await aicreditsChatDetailed(GROWTH_REASONING_MODEL, messages, {
      temperature: 0,
      max_tokens: 40,
      response_format: pingSchema,
    });
    return {
      support: "yes",
      mode: "json_schema",
      responseFormat: QUALIFICATION_JSON_SCHEMA_FORMAT,
      usage: detailed.usage,
      sample: String(detailed.content || "").slice(0, 80),
    };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 220);
    try {
      const detailed = await aicreditsChatDetailed(GROWTH_REASONING_MODEL, messages, {
        temperature: 0,
        max_tokens: 40,
        response_format: QUALIFICATION_JSON_OBJECT_FORMAT,
      });
      return {
        support: "partial",
        mode: "json_object",
        responseFormat: QUALIFICATION_JSON_OBJECT_FORMAT,
        usage: detailed.usage,
        sample: String(detailed.content || "").slice(0, 80),
        schemaError: msg,
      };
    } catch (e2) {
      return {
        support: "no",
        mode: null,
        responseFormat: null,
        error: msg,
        jsonObjectError: String(e2?.message || e2).slice(0, 220),
      };
    }
  }
}

export async function runReasonerDiagnostic({ chatFn, responseFormat }) {
  const rows = [];
  for (const id of DIAGNOSTIC_CASE_IDS) {
    const c = EVAL_CASES.find((x) => x.id === id);
    const out = await qualifyProspect({
      pack: c.pack,
      productProfile: c.productProfile,
      chatFn,
      responseFormat,
      maxAttempts: 1,
    });
    const q = out.qualification;
    const zt = scoreZeroTolerance(q, c.pack, c.productProfile);
    const cited = citationsUsed(q);
    const fitAsserts = ["strong_fit", "possible_fit", "weak_fit", "not_fit"].includes(q?.decision);
    const sparseOk = c.id === "missing_evidence" && q?.decision === "insufficient_evidence";
    const groundedOk = !fitAsserts || cited.length > 0 || sparseOk;
    const ztFail =
      (zt.unknownEvidenceIds || 0) +
        (zt.inventedContacts || 0) +
        (zt.injectionCompliance || 0) +
        (zt.abandonedOrRevenue || 0) +
        (zt.platformHallucination || 0) +
        (zt.productCopyAttributed || 0) >
      0;
    const pass = Boolean(out.ok) && groundedOk && !ztFail;
    rows.push({
      id: c.id,
      ok: out.ok,
      decision: q?.decision || null,
      citations: cited,
      groundedReasonCount: cited.length,
      structuralOk: Boolean(out.ok),
      unknownBefore: out.usage?.contract?.unknownBefore || [],
      unknownAfter: out.usage?.contract?.unknownAfter || [],
      zt,
      pass,
      errors: out.errors || (out.error ? [out.error] : []),
    });
  }
  return {
    rows,
    pass: rows.every((r) => r.pass) && rows.length === DIAGNOSTIC_CASE_IDS.length,
  };
}

export function printOffline() {
  const cases = selectedCases();
  const liveCases = cases.filter((c) => !c.shortCircuit).length;
  const ceiling = resolvedCeiling();
  console.log("Growth qualification eval — OFFLINE (0 LLM calls)");
  console.log(`fixture count=${cases.length}`);
  console.log(`maximum reasoner calls=${liveCases * 2}`);
  console.log(`maximum critic calls=${liveCases + selectedCorruptCases().length}`);
  console.log(`absolute maximum calls=${ceiling}`);
  console.log("Set GROWTH_EVAL_LIVE=1 to run the bounded live evaluation.");
  for (const c of cases) {
    console.log(`- ${c.id} expected=${c.expectedBand.join("|")} shortCircuit=${Boolean(c.shortCircuit)}`);
  }
}

async function main() {
  loadLocalEnv();
  const live = String(process.env.GROWTH_EVAL_LIVE || "") === "1";
  if (!live) {
    printOffline();
    return;
  }

  const cfg = getAicreditsConfig();
  if (!cfg.configured) {
    console.error("AICREDITS is not configured. Aborting with 0 calls.");
    process.exit(2);
  }

  console.log("Growth qualification eval — LIVE Phase 2E");
  console.log(`model=${GROWTH_REASONING_MODEL}`);
  console.log(`diagnostic cases=${DIAGNOSTIC_CASE_IDS.join(",")}`);
  console.log("maximum diagnostic reasoner calls=3 (no JSON retry)");
  console.log(`absolute Phase 2E ceiling=${PHASE_2E_CEILING}`);
  console.log("structured output=json_schema strict (no capability probe this phase)");

  const diagBudget = createBudgetedChat({ maxCalls: 3 });
  const diagnostic = await runReasonerDiagnostic({
    chatFn: diagBudget.chatFn,
    responseFormat: QUALIFICATION_JSON_SCHEMA_FORMAT,
  });
  const diagnosticCalls = diagBudget.stats().calls;
  console.log(
    "diagnostic",
    JSON.stringify(diagnostic.rows.map((r) => ({ id: r.id, pass: r.pass, decision: r.decision, citations: r.citations, unknownBefore: r.unknownBefore })))
  );

  const outPath = path.join(process.cwd(), "growth-eval-report.json");
  if (!diagnostic.pass) {
    const report = {
      phase: "2E",
      structuredOutput: { support: "yes", mode: "json_schema" },
      diagnostic,
      diagnosticCalls,
      fullEvalRan: false,
      totalCalls: diagnosticCalls,
    };
    fs.writeFileSync(outPath, JSON.stringify(sanitizeReport(report), null, 2));
    console.log("Diagnostic gate FAILED. Stopping. report", outPath);
    return;
  }

  const remaining = PHASE_2E_CEILING - diagnosticCalls;
  console.log(`Diagnostic gate PASSED. Full eval remaining budget=${remaining}`);
  const cases = selectedCases();
  const corruptCases = selectedCorruptCases();
  const budget = createBudgetedChat({ maxCalls: remaining });
  const report = await runLiveEval({
    chatFn: budget.chatFn,
    getStats: budget.stats,
    maxCalls: remaining,
    cases,
    corruptCases,
    responseFormat: QUALIFICATION_JSON_SCHEMA_FORMAT,
    maxAttempts: 1,
  });
  report.phase = "2E";
  report.structuredOutput = { support: "yes", mode: "json_schema" };
  report.diagnostic = diagnostic;
  report.diagnosticCalls = diagnosticCalls;
  report.fullEvalRan = true;
  report.totalLiveCalls = diagnosticCalls + report.totalCalls;
  report.callSplit = {
    diagnosticReasoner: diagnosticCalls,
    evalReasoner: report.pipeline.reduce((n, p) => n + (p.reasonerCalls || 0), 0),
    evalCritic: report.pipeline.reduce((n, p) => n + (p.criticCalls || 0), 0),
    evalTotal: report.totalCalls,
  };
  fs.writeFileSync(outPath, JSON.stringify(sanitizeReport(report), null, 2));

  for (const row of report.pipeline) {
    console.log(
      `CASE ${row.id} decision=${row.decision} critic=${row.critic} final=${row.final} grounded=${row.groundedReasonCount} calls=${row.calls} ${row.pass ? "PASS" : "FAIL"}`
    );
  }
  console.log("aggregates", JSON.stringify(report.aggregates));
  console.log("grounding", JSON.stringify(report.grounding));
  console.log("criticEffectiveness", JSON.stringify(report.criticEffectiveness));
  console.log("tokenTotals", JSON.stringify(report.tokenTotals));
  console.log("callSplit", JSON.stringify(report.callSplit));
  console.log("totalLiveCalls", report.totalLiveCalls);
  console.log("report", outPath);
}

function sanitizeReport(report) {
  const json = JSON.stringify(report);
  if (/AICREDITS_API_KEY|sk-|Bearer /.test(json)) {
    throw new Error("Refusing to write a report that looks like it contains secrets.");
  }
  return report;
}

const isMain = process.argv[1] && path.normalize(process.argv[1]).includes("qualification-eval.js");
if (isMain) {
  main().catch((e) => {
    console.error(String(e?.message || e).slice(0, 300));
    process.exit(1);
  });
}
