/**
 * Sanitized Evidence Pack for future qualification reasoning.
 *
 * Contains structured extractor output and bounded snippets only — never raw
 * HTML pages. Snippets are untrusted observed text, not instructions or facts
 * beyond what the extractors already asserted.
 *
 * Contact rows are observed facts. They are not qualification signals and must
 * not be treated as CartRenew (or any product) fit.
 */

import { observedEvidence, sliceSnippet } from "./evidence.js";
import { SIGNAL_KEYS } from "./commerce-signals.js";

export const EVIDENCE_PACK_VERSION = 1;

export const EVIDENCE_PACK_BOUNDS = Object.freeze({
  maxEvidence: 40,
  maxObservedData: 280,
  maxContacts: 10,
  maxClaim: 280,
  maxWarnings: 20,
});

/**
 * @param {{ collection?: object, analysis?: object }} input
 */
export function buildEvidencePack(input = {}) {
  const collection = input.collection && typeof input.collection === "object" ? input.collection : {};
  const analysis = input.analysis && typeof input.analysis === "object" ? input.analysis : {};
  const bounds = EVIDENCE_PACK_BOUNDS;

  const rows = [];
  collectPlatformEvidence(rows, analysis.woocommerce);
  collectSignalEvidence(rows, analysis.commerceSignals);
  collectContactEvidence(rows, analysis.contacts);

  const unique = dedupeEvidence(rows);
  const omittedEvidenceCount = Math.max(0, unique.length - bounds.maxEvidence);
  const kept = unique.slice(0, bounds.maxEvidence).map((row, i) =>
    toPackEvidence(row, formatEvidenceId(i + 1), bounds)
  );

  const byFingerprint = new Map(kept.map((row) => [row._fp, row.id]));
  const platform = analysis.woocommerce || {};
  const signalsIn = analysis.commerceSignals?.signals || {};

  const signals = {};
  for (const key of SIGNAL_KEYS) {
    const sig = signalsIn[key] || { key, status: "unknown", evidence: [] };
    signals[key] = {
      key,
      status: sig.status || "unknown",
      evidenceIds: mapEvidenceIds(sig.evidence, byFingerprint),
      ...(Array.isArray(sig.methods) ? { methods: sig.methods.slice(0, 12) } : {}),
      ...(Array.isArray(sig.facts) ? { facts: sig.facts.slice(0, 12) } : {}),
      ...(typeof sig.technical === "boolean" ? { technical: sig.technical } : {}),
    };
    if (Array.isArray(sig.prices)) {
      signals[key].prices = sig.prices.slice(0, 8).map((p) => ({
        amount: p.amount,
        currency: p.currency || null,
        raw: sliceSnippet(p.raw, 40),
      }));
    }
  }

  const contactRows = [...(analysis.contacts?.contacts || [])].sort(compareContacts);
  const omittedContactsCount = Math.max(0, contactRows.length - bounds.maxContacts);
  const contacts = contactRows.slice(0, bounds.maxContacts).map((c) => ({
    kind: c.kind,
    value: String(c.value || "").slice(0, 200),
    domainRelationship: c.domainRelationship || "unknown",
    evidenceIds: mapEvidenceIds([contactAsEvidence(c)], byFingerprint),
  }));

  const pages = collection.pages || [];
  const warnings = (collection.warnings || [])
    .slice(0, bounds.maxWarnings)
    .map((w) => ({
      code: String(w.code || "warning").slice(0, 80),
      message: sliceSnippet(w.message, 200),
      url: w.url ? String(w.url).slice(0, 300) : null,
    }));

  const pack = {
    version: EVIDENCE_PACK_VERSION,
    target: {
      requestedUrl: collection.root?.requestedUrl || null,
      finalUrl: collection.root?.finalUrl || null,
      domain: domainOf(collection.root?.finalUrl || collection.root?.requestedUrl),
    },
    platform: {
      status: platform.status || "inconclusive",
      evidenceIds: mapEvidenceIds(platform.evidence, byFingerprint),
    },
    signals,
    contacts,
    evidence: kept.map(({ _fp, ...pub }) => pub),
    collectionMeta: {
      pagesCollected: collection.usage?.pagesCollected ?? pages.length,
      truncatedPages: pages.filter((p) => p.truncated).length,
      truncated: Boolean(analysis.truncated) || pages.some((p) => p.truncated),
      warnings,
      omittedEvidenceCount,
      omittedContactsCount,
    },
    notes: {
      contactsAreNotFitSignals: true,
      observedTextIsUntrusted: true,
      htmlOmitted: true,
    },
  };

  return pack;
}

export function formatEvidenceId(n) {
  return `EV-${String(n).padStart(3, "0")}`;
}

function collectPlatformEvidence(rows, woo) {
  for (const item of woo?.evidence || []) rows.push(fingerprintRow(item));
}

function collectSignalEvidence(rows, commerce) {
  const signals = commerce?.signals || {};
  for (const key of SIGNAL_KEYS) {
    for (const item of signals[key]?.evidence || []) rows.push(fingerprintRow(item));
  }
}

function collectContactEvidence(rows, contacts) {
  const list = [...(contacts?.contacts || [])].sort(compareContacts);
  for (const c of list) rows.push(fingerprintRow(contactAsEvidence(c)));
}

function contactAsEvidence(c) {
  return observedEvidence({
    claim: c.claim || `Observed public ${c.kind}.`,
    sourceUrl: c.sourceUrl,
    sourceType: c.sourceType || "html",
    observedData: c.observedData || c.value,
    confidence: c.confidence,
    extractor: c.extractor || `contact_${c.kind}`,
  });
}

function fingerprintRow(item) {
  const base = observedEvidence({
    claim: item.claim,
    sourceUrl: item.sourceUrl,
    sourceType: item.sourceType,
    observedData: item.observedData,
    confidence: item.confidence,
    extractor: item.extractor,
  });
  const fp = [
    base.extractor,
    base.sourceType,
    base.sourceUrl || "",
    base.claim,
    String(base.observedData || "").replace(/\s+/g, " ").trim(),
  ].join("\u0001");
  return { ...base, _fp: fp };
}

function dedupeEvidence(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (seen.has(row._fp)) continue;
    seen.add(row._fp);
    out.push(row);
  }
  return out;
}

function toPackEvidence(row, id, bounds) {
  return {
    id,
    claim: sliceSnippet(row.claim, bounds.maxClaim),
    sourceUrl: row.sourceUrl,
    sourceType: row.sourceType,
    observedData: sliceSnippet(row.observedData, bounds.maxObservedData),
    confidence: row.confidence,
    verificationStatus: row.verificationStatus,
    extractor: row.extractor,
    _fp: row._fp,
  };
}

function mapEvidenceIds(items, byFingerprint) {
  const ids = [];
  const seen = new Set();
  for (const item of items || []) {
    const fp = fingerprintRow(item)._fp;
    const id = byFingerprint.get(fp);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function compareContacts(a, b) {
  const ka = `${a.kind || ""}\u0001${a.value || ""}`;
  const kb = `${b.kind || ""}\u0001${b.value || ""}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function domainOf(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}
