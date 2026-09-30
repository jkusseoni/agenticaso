/**
 * Qualification I/O contract and deterministic validator.
 *
 * This is a structural trust boundary for a future LLM. It does NOT prove that
 * natural-language statements are entailed by cited evidence. A later critic
 * may judge semantic support. This module only checks:
 * - allowed enums and types
 * - citation integrity (IDs exist on the pack)
 * - array/string bounds
 * - forbidden fields (no invented evidence/contacts; pack is not mutated)
 *
 * CartRenew (or any product) is supplied as a profile object, never hard-coded.
 */

import { SIGNAL_KEYS } from "./commerce-signals.js";

export const QUALIFICATION_DECISIONS = Object.freeze([
  "strong_fit",
  "possible_fit",
  "weak_fit",
  "not_fit",
  "insufficient_evidence",
]);

export const REASON_TYPES = Object.freeze(["observation", "inference"]);

export const QUALIFICATION_GOALS = Object.freeze([
  "qualified_trial",
  "conversation",
  "demo",
  "unspecified",
]);

export const TARGET_PLATFORMS = Object.freeze(["woocommerce", "unspecified"]);

export const QUALIFICATION_BOUNDS = Object.freeze({
  maxSummary: 600,
  maxStatement: 400,
  maxReasons: 8,
  maxUncertainties: 8,
  maxEvidenceIdsPerItem: 8,
});

export const ALLOWED_RESULT_KEYS = Object.freeze(["decision", "summary", "reasons", "uncertainties"]);
export const ALLOWED_REASON_KEYS = Object.freeze(["statement", "evidenceIds", "type"]);

/**
 * Normalize a caller-supplied product/ICP profile. Does not persist.
 * Product proof points are descriptions, not observed prospect facts.
 *
 * @param {object} [raw]
 */
export function normalizeProductProfile(raw = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const product = src.product && typeof src.product === "object" ? src.product : {};
  const goal = QUALIFICATION_GOALS.includes(src.goal) ? src.goal : "unspecified";
  const targetPlatform = TARGET_PLATFORMS.includes(src.targetPlatform)
    ? src.targetPlatform
    : "unspecified";
  const desired = Array.isArray(src.desiredSignals)
    ? src.desiredSignals.filter((k) => SIGNAL_KEYS.includes(k))
    : [];

  return {
    product: {
      name: String(product.name || "").slice(0, 80),
      url: String(product.url || "").slice(0, 300),
      description: String(product.description || "").slice(0, 500),
    },
    goal,
    targetPlatform,
    desiredSignals: desired.slice(0, SIGNAL_KEYS.length),
  };
}

/**
 * Validate a future model result against an Evidence Pack.
 * Never writes into the pack. Returns a sanitized copy on success.
 *
 * @param {object} result
 * @param {object} evidencePack
 * @returns {{ ok: true, result: object } | { ok: false, errors: string[] }}
 */
export function validateQualificationResult(result, evidencePack) {
  const errors = [];
  const packSnapshot = stableStringify(evidencePack);

  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ok: false, errors: ["result_not_object"] };
  }

  for (const key of Object.keys(result)) {
    if (!ALLOWED_RESULT_KEYS.includes(key)) {
      errors.push(`unexpected_field:${key}`);
    }
  }

  if (Object.prototype.hasOwnProperty.call(result, "evidence")) {
    errors.push("must_not_create_evidence");
  }
  if (Object.prototype.hasOwnProperty.call(result, "contacts")) {
    errors.push("must_not_add_contacts");
  }

  if (!QUALIFICATION_DECISIONS.includes(result.decision)) {
    errors.push("invalid_decision");
  }

  const summary = result.summary == null ? "" : String(result.summary);
  if (summary.length > QUALIFICATION_BOUNDS.maxSummary) {
    errors.push("summary_too_long");
  }

  const reasons = validateItemList(result.reasons, "reasons", QUALIFICATION_BOUNDS.maxReasons, evidencePack, errors);
  const uncertainties = validateItemList(
    result.uncertainties,
    "uncertainties",
    QUALIFICATION_BOUNDS.maxUncertainties,
    evidencePack,
    errors
  );

  if (stableStringify(evidencePack) !== packSnapshot) {
    errors.push("evidence_pack_mutated");
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    result: {
      decision: result.decision,
      summary,
      reasons,
      uncertainties,
    },
  };
}

/**
 * LLM output with no retained grounded reasons must never be accepted.
 *
 * - insufficient_evidence + 0 reasons → needs_review (cautious, allowed)
 * - any other LLM decision + 0 reasons → needs_review (never accept)
 * - critic pass cannot override this to accept
 * - critic fail still rejects (more severe than needs_review)
 * Short-circuit platform contradiction is deterministic, not this rule.
 */
export function hasGroundedReasons(qualification) {
  return (qualification?.reasons || []).some((r) => Array.isArray(r.evidenceIds) && r.evidenceIds.length > 0);
}

export function applyGroundingInvariant(qualification, proposedStatus, opts = {}) {
  if (opts.shortCircuited) {
    return { blocked: false, status: proposedStatus, rule: "short_circuit" };
  }
  if (hasGroundedReasons(qualification)) {
    return { blocked: false, status: proposedStatus, rule: "has_grounded_reasons" };
  }
  if (proposedStatus !== "accept") {
    return { blocked: false, status: proposedStatus, rule: "already_not_accept" };
  }
  const rule =
    qualification?.decision === "insufficient_evidence"
      ? "insufficient_evidence_zero_reasons"
      : "ungrounded_llm_decision";
  return { blocked: true, status: "needs_review", rule };
}

function validateItemList(list, label, max, pack, errors) {
  if (list == null) return [];
  if (!Array.isArray(list)) {
    errors.push(`${label}_not_array`);
    return [];
  }
  if (list.length > max) {
    errors.push(`${label}_too_many`);
  }
  const known = new Set((pack?.evidence || []).map((e) => e.id));
  const out = [];
  for (const item of list.slice(0, max + 1)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${label}_item_not_object`);
      continue;
    }
    for (const key of Object.keys(item)) {
      if (!ALLOWED_REASON_KEYS.includes(key)) errors.push(`${label}_unexpected_field:${key}`);
    }
    const statement = item.statement == null ? "" : String(item.statement);
    if (!statement.trim()) continue;
    if (statement.length > QUALIFICATION_BOUNDS.maxStatement) errors.push(`${label}_statement_too_long`);

    const type = item.type == null ? "inference" : item.type;
    if (!REASON_TYPES.includes(type)) errors.push(`${label}_invalid_type`);

    const idsRaw = item.evidenceIds;
    if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
      if (label === "uncertainties") {
        out.push({ type, statement, evidenceIds: [] });
        continue;
      }
      // Ungrounded reasons are dropped. IDs are never invented.
      continue;
    }
    if (idsRaw.length > QUALIFICATION_BOUNDS.maxEvidenceIdsPerItem) {
      errors.push(`${label}_too_many_evidence_ids`);
    }
    const ids = [];
    const seen = new Set();
    for (const id of idsRaw) {
      if (typeof id !== "string" || !/^EV-\d{3}$/.test(id)) {
        if (label === "uncertainties") continue;
        errors.push(`${label}_invalid_evidence_id`);
        continue;
      }
      if (!known.has(id)) {
        if (label === "uncertainties") continue;
        errors.push(`${label}_unknown_evidence_id:${id}`);
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    if (!ids.length) {
      if (label === "uncertainties") {
        out.push({ type, statement, evidenceIds: [] });
      }
      continue;
    }
    out.push({ type, statement, evidenceIds: ids });
  }
  return out;
}

/**
 * Format-only adapter: aliases and padding. Never invents evidence IDs,
 * never changes decision, never rewrites factual wording.
 *
 * Safe: text/claim/reason → statement; EV-1 → EV-001; extra keys dropped;
 * string uncertainties → uncited uncertainty objects.
 * Unsafe (not done): attaching pack IDs to uncited reasons.
 */
export function coerceQualificationShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return {
    decision: value.decision,
    summary: value.summary,
    reasons: Array.isArray(value.reasons) ? value.reasons.map(coerceReasonItem) : value.reasons,
    uncertainties: Array.isArray(value.uncertainties)
      ? value.uncertainties.map(coerceReasonItem)
      : [],
  };
}

function coerceReasonItem(item) {
  if (typeof item === "string") {
    return { type: "inference", statement: item, evidenceIds: [] };
  }
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const rawIds = item.evidenceIds || item.evidence_ids || item.citations;
  const ids = Array.isArray(rawIds)
    ? rawIds.map((id) => {
        const m = String(id).match(/^EV-(\d+)$/i);
        return m ? `EV-${m[1].padStart(3, "0")}` : id;
      })
    : rawIds;
  return {
    type: item.type,
    statement: item.statement || item.text || item.claim || item.reason || "",
    evidenceIds: ids,
  };
}

/**
 * Raw exact-contract check vs safe-normalized check. Used for eval metrics.
 */
export function assessQualificationContract(value, pack) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      rawOk: false,
      normalizedOk: false,
      rawErrors: ["result_not_object"],
      normalizedErrors: ["result_not_object"],
      result: null,
    };
  }
  const raw = validateQualificationResult(value, pack);
  const coerced = coerceQualificationShape(value);
  const normalized = validateQualificationResult(coerced, pack);
  return {
    rawOk: Boolean(raw.ok),
    normalizedOk: Boolean(normalized.ok),
    rawErrors: raw.ok ? [] : raw.errors || [],
    normalizedErrors: normalized.ok ? [] : normalized.errors || [],
    unknownBefore: unknownCitationIds(value, pack),
    unknownAfter: unknownCitationIds(normalized.ok ? normalized.result : coerced, pack),
    result: normalized.ok ? normalized.result : null,
  };
}

export function listCitationIds(value) {
  const ids = [];
  for (const item of [...(value?.reasons || []), ...(value?.uncertainties || [])]) {
    if (!item || typeof item !== "object") continue;
    for (const id of item.evidenceIds || []) ids.push(id);
  }
  return ids;
}

export function unknownCitationIds(value, pack) {
  const known = new Set((pack?.evidence || []).map((e) => e.id));
  return listCitationIds(value).filter((id) => !known.has(id));
}

function stableStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
