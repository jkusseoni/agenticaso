/**
 * Deterministic Growth persistence helpers (no Prisma calls required).
 * Identity, campaign config, and qualification serialization for a later repository.
 */

import { EVIDENCE_PACK_VERSION } from "./evidence-pack.js";
import {
  applyGroundingInvariant,
  hasGroundedReasons,
  normalizeProductProfile,
} from "./qualification-contract.js";
import { REVIEW_STATES } from "./state-machine.js";

export const GROWTH_PROVENANCE = Object.freeze({
  evidencePackVersion: EVIDENCE_PACK_VERSION,
  qualificationContractVersion: 1,
  reasonerPromptVersion: 1,
  criticPromptVersion: 1,
  schemaVersion: 1,
});

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "ref",
  "referrer",
]);

/**
 * Offline storefront identity. No DNS, no ownership resolution.
 * Strips www, credentials, hash, and common tracking query params.
 */
export function normalizeProspectIdentity(raw) {
  const input = String(raw || "").trim();
  if (!input) return { ok: false, error: "empty_url" };
  let href = input;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) href = `https://${href}`;
  let u;
  try {
    u = new URL(href);
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: "unsupported_protocol" };
  }
  if (u.username || u.password) {
    return { ok: false, error: "credentials_not_allowed" };
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host.includes(".") || host === "localhost") {
    return { ok: false, error: "not_a_public_domain" };
  }
  const canonicalDomain = host.replace(/^www\./, "");
  const kept = new URLSearchParams();
  for (const [key, value] of u.searchParams.entries()) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) continue;
    kept.append(key, value);
  }
  let pathname = u.pathname || "/";
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
  const search = kept.toString();
  const normalizedUrl = `https://${canonicalDomain}${pathname === "/" ? "" : pathname}${search ? `?${search}` : ""}`;
  return {
    ok: true,
    originalUrl: input,
    normalizedUrl,
    canonicalDomain,
  };
}

export function prospectDedupeKey(campaignId, canonicalDomain) {
  return `${campaignId}\u0001${canonicalDomain}`;
}

export function createCampaignData(workspaceId, input = {}) {
  const profile = normalizeProductProfile(input.productProfile || input);
  const name = String(input.name || profile.product.name || "Untitled campaign").slice(0, 120);
  return {
    workspaceId,
    name,
    status: input.status && ["draft", "active", "paused", "completed", "archived"].includes(input.status)
      ? input.status
      : "draft",
    productName: profile.product.name,
    productUrl: profile.product.url,
    productDescription: profile.product.description,
    goal: profile.goal,
    targetPlatform: profile.targetPlatform,
    desiredSignals: profile.desiredSignals,
  };
}

export function boundErrorMessage(text) {
  return String(text || "").slice(0, 300);
}

/**
 * Map a pipeline result into persistable records.
 * Never serializes reviewState=accepted when the grounding invariant forbids it.
 * Does not mutate the qualification or attach invented evidence IDs.
 */
export function serializeQualificationForPersistence(input = {}) {
  const qualification = input.qualification;
  const critic = input.critic;
  const shortCircuited = Boolean(input.shortCircuited || input.reasoner?.shortCircuited);
  const proposedReview =
    input.reviewState && REVIEW_STATES.includes(input.reviewState)
      ? input.reviewState
      : fromPipelineStatus(input.status);

  const proposedPipeline = toPipelineStatus(proposedReview);
  const invariant = applyGroundingInvariant(qualification, proposedPipeline, {
    shortCircuited,
  });
  const reviewState = fromPipelineStatus(invariant.status);

  const reasons = (qualification?.reasons || []).map((r, i) => ({
    type: r.type,
    statement: r.statement,
    sortOrder: i,
    packEvidenceIds: [...(r.evidenceIds || [])],
  }));

  const usage = input.reasoner?.usage || input.usage || {};
  const producedBy = shortCircuited ? "deterministic" : "llm";
  return {
    trusted: reviewState === "accepted" && (shortCircuited || hasGroundedReasons(qualification)),
    reviewState,
    invariant,
    qualification: {
      decision: qualification?.decision,
      summary: String(qualification?.summary || "").slice(0, 600),
      producedBy,
      shortCircuited,
      structuralOk: Boolean(input.reasoner?.ok ?? input.structuralOk ?? true),
      reasonerModel: shortCircuited ? null : usage.model || input.reasonerModel || null,
      reasonerProvider: shortCircuited ? null : input.reasonerProvider || null,
      uncertainties: qualification?.uncertainties || [],
      evidencePackVersion: GROWTH_PROVENANCE.evidencePackVersion,
      qualificationContractVersion: GROWTH_PROVENANCE.qualificationContractVersion,
      reasonerPromptVersion: GROWTH_PROVENANCE.reasonerPromptVersion,
      schemaVersion: GROWTH_PROVENANCE.schemaVersion,
      reasonerCallCount: shortCircuited ? 0 : usage.llmCalls ?? null,
      promptTokens: shortCircuited ? null : usage.promptTokens ?? input.promptTokens ?? null,
      completionTokens: shortCircuited ? null : usage.completionTokens ?? input.completionTokens ?? null,
      totalTokens: shortCircuited ? null : usage.totalTokens ?? input.totalTokens ?? null,
    },
    reasons,
    critic: critic
      ? {
          policyVerdict: critic.policy?.verdict || null,
          llmVerdict: critic.llmReview?.verdict || null,
          finalVerdict: critic.verdict || critic.finalVerdict || null,
          reviewState,
          criticModel: critic.usage?.model || input.criticModel || null,
          criticProvider: input.criticProvider || null,
          items: critic.items || null,
          criticPromptVersion: GROWTH_PROVENANCE.criticPromptVersion,
          promptTokens: critic.usage?.promptTokens ?? null,
          completionTokens: critic.usage?.completionTokens ?? null,
          totalTokens: critic.usage?.totalTokens ?? null,
        }
      : null,
  };
}

function toPipelineStatus(review) {
  if (review === "accepted" || review === "accept") return "accept";
  if (review === "rejected" || review === "reject") return "reject";
  return "needs_review";
}

function fromPipelineStatus(status) {
  if (status === "accept" || status === "accepted") return "accepted";
  if (status === "reject" || status === "rejected") return "rejected";
  return "needs_review";
}

export function schemaForbidsRawHtml(schemaText) {
  return !/\brawHtml\b/i.test(String(schemaText || ""));
}
