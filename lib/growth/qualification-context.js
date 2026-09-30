/**
 * Compact, deterministic qualification context.
 * Same Evidence Pack facts; no new evidence; no raw HTML.
 * Contacts are listed as observed-not-fit, never as ICP signals.
 */

function shortUrl(url) {
  const s = String(url || "");
  if (s.length <= 80) return s;
  return `${s.slice(0, 77)}...`;
}

function compactSignals(pack) {
  const out = {};
  for (const [key, sig] of Object.entries(pack?.signals || {})) {
    if (!sig || sig.status === "unknown") continue;
    out[key] = {
      status: sig.status,
      evidenceIds: sig.evidenceIds || [],
      ...(Array.isArray(sig.methods) && sig.methods.length ? { methods: sig.methods } : {}),
      ...(Array.isArray(sig.prices) && sig.prices.length
        ? { prices: sig.prices.map((p) => ({ amount: p.amount, currency: p.currency, raw: p.raw })) }
        : {}),
    };
  }
  return out;
}

function renderEvidenceRecords(pack) {
  return (pack?.evidence || []).map((row) => {
    const id = row.id;
    const claim = String(row.claim || "").slice(0, 280);
    const observed = String(row.observedData || "").slice(0, 280);
    const source = shortUrl(row.sourceUrl);
    return { id, claim, observed, source };
  });
}

export function buildQualificationContext(pack) {
  const evidence = renderEvidenceRecords(pack);
  const lines = evidence.map(
    (e) => `${e.id}\nClaim: ${e.claim}\nObserved: ${e.observed}\nSource: ${e.source}`
  );
  const contacts = (pack?.contacts || []).map((c) => ({
    kind: c.kind,
    value: c.value,
    evidenceIds: c.evidenceIds || [],
  }));

  return {
    platform: { status: pack?.platform?.status || "inconclusive", evidenceIds: pack?.platform?.evidenceIds || [] },
    signals: compactSignals(pack),
    evidence,
    contactsNotFitEvidence: contacts,
    renderedEvidence: lines.join("\n\n"),
    evidenceIds: evidence.map((e) => e.id),
  };
}

export function formatQualificationUserContent(pack, productProfileJson) {
  const ctx = buildQualificationContext(pack);
  const contactBlock =
    ctx.contactsNotFitEvidence.length === 0
      ? "(none observed)"
      : ctx.contactsNotFitEvidence
          .map((c) => `- ${c.kind}: ${c.value} (observed contact, not a fit signal)`)
          .join("\n");

  return [
    "A. PRODUCT / ICP CONTEXT (not prospect evidence):",
    productProfileJson,
    "",
    "B. PROSPECT EVIDENCE (only source of prospect facts). Cite ids exactly as written:",
    `platform.status=${ctx.platform.status} platform.evidenceIds=${JSON.stringify(ctx.platform.evidenceIds)}`,
    `signals=${JSON.stringify(ctx.signals)}`,
    "",
    ctx.renderedEvidence || "(no evidence rows)",
    "",
    "C. OBSERVED CONTACTS (NOT fit evidence; do not use to raise fit):",
    contactBlock,
  ].join("\n");
}

export function packHasRawHtml(text) {
  return /<html[\s>]|<\/html>/i.test(String(text || ""));
}
