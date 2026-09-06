/**
 * Phase G — AI Action Engine.
 * Builds reviewable, persistable snippets (JSON-LD, llms.txt, FAQ, meta tags).
 * Does not invent awards, traffic, or unverified product facts.
 */
import { diagnoseAudit } from "./diagnosis/diagnose.js";
import { generateFix, sanitizeSuggestedContent } from "./diagnosis/fixes.js";

export const FIX_CATEGORIES = Object.freeze({
  STRUCTURED_DATA: "STRUCTURED_DATA",
  LLMS_TXT: "LLMS_TXT",
  FAQ: "FAQ",
  META_TAGS: "META_TAGS",
});

const REVIEW = "Suggested — review before publishing.";

/**
 * @param {string} raw
 */
export function hostFromDomain(raw) {
  const s = String(raw || "").trim();
  if (!s) return "example.com";
  return s.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/^www\./i, "") || "example.com";
}

/**
 * Draft snippets for an audit. Always labeled as suggestions.
 * Explicit action-pack generation (`pack: true`) emits all four categories.
 * Gated mode only emits drafts backed by diagnosis signals.
 * @param {{ audit: object, diagnosisData?: object, pack?: boolean }} input
 */
export function buildAuditFixDrafts({ audit, diagnosisData, pack = false } = {}) {
  const website = audit?.website || {};
  const domain = hostFromDomain(website.domain || website.url);
  const brandName = website.brandName || domain || "Your brand";
  const category = website.category || "your category";
  const description = String(website.description || "").trim();
  const issues = Array.isArray(diagnosisData?.issues)
    ? diagnosisData.issues
    : diagnoseAudit(audit).issues || [];
  const issueIds = new Set(issues.map((i) => i.id));

  const drafts = [];

  if (pack || shouldOfferStructuredData(issueIds, audit)) {
    drafts.push(structuredDataFix({ domain, brandName, description, category }));
  }
  if (pack || shouldOfferLlmsTxt(issueIds, audit)) {
    drafts.push(llmsTxtFix({ domain, brandName, description, category }));
  }
  if (pack || shouldOfferFaq(issueIds, audit)) {
    drafts.push(faqFix({ domain, brandName, category, questions: audit?.questions || [] }));
  }
  if (pack || shouldOfferMetaTags(issueIds, audit)) {
    drafts.push(metaTagsFix({ domain, brandName, category }));
  }

  return drafts;
}

function shouldOfferStructuredData(issueIds, audit) {
  return (
    issueIds.has("incomplete_structured_signals") ||
    issueIds.has("weak_entity_clarity") ||
    Number(audit?.agenticScore?.understood?.score) < 55
  );
}

function shouldOfferLlmsTxt(issueIds, audit) {
  return shouldOfferStructuredData(issueIds, audit) || issueIds.has("cross_ai_invisibility");
}

function shouldOfferFaq(issueIds, audit) {
  return (
    issueIds.has("weak_buyer_intent_coverage") ||
    issueIds.has("low_recommendation_share") ||
    issueIds.has("missing_comparison_content") ||
    (audit?.questions || []).some((q) => ["purchase", "problem", "comparison"].includes(q.category))
  );
}

function shouldOfferMetaTags(issueIds, audit) {
  return (
    issueIds.has("weak_entity_clarity") ||
    issueIds.has("cross_ai_invisibility") ||
    shouldOfferStructuredData(issueIds, audit)
  );
}

function structuredDataFix({ domain, brandName, description, category }) {
  const jsonLdPayload = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `https://${domain}/#organization`,
        name: brandName,
        url: `https://${domain}`,
        description: description || `[Add one factual sentence about ${brandName} in ${category}.]`,
      },
      {
        "@type": "WebSite",
        "@id": `https://${domain}/#website`,
        url: `https://${domain}`,
        name: brandName,
        publisher: { "@id": `https://${domain}/#organization` },
      },
    ],
  };

  return {
    category: FIX_CATEGORIES.STRUCTURED_DATA,
    title: "Add Schema.org JSON-LD metadata",
    description: `${REVIEW} Embed Organization + WebSite entities. Verify every field before publishing.`,
    codeSnippet: `<script type="application/ld+json">\n${JSON.stringify(jsonLdPayload, null, 2)}\n</script>`,
    language: "html",
  };
}

function llmsTxtFix({ domain, brandName, description, category }) {
  const body = `# ${brandName}
> ${description || `[One factual sentence about ${brandName} (${category}).]`}

## Site
- Home: https://${domain}
- Catalog: https://${domain}/  [replace with your real catalog URL]

## Entity
- Brand: ${brandName}
- Category: ${category}
- Support: [your public support email]
- Policies: [link to your refund/terms pages]

${REVIEW}
`;

  return {
    category: FIX_CATEGORIES.LLMS_TXT,
    title: "Generate /llms.txt file",
    description: `${REVIEW} Place at the site root so agents can retrieve a concise, factual brand summary.`,
    codeSnippet: sanitizeSuggestedContent(body),
    language: "markdown",
  };
}

function faqFix({ domain, brandName, category, questions }) {
  const picks = (questions || [])
    .filter((q) => ["purchase", "problem", "comparison", "discovery"].includes(q.category))
    .slice(0, 4);
  const items =
    picks.length > 0
      ? picks
          .map(
            (q) => `### ${q.question}\n[Answer with verified facts about ${brandName} on ${domain} only.]\n`
          )
          .join("\n")
      : `### What is ${brandName}?\n[One factual sentence.]\n\n### Who is ${brandName} for?\n[Describe real customers — do not invent personas.]\n`;

  const body = `## FAQ for ${category} buyers\n\n${items}\n${REVIEW}\n`;
  return {
    category: FIX_CATEGORIES.FAQ,
    title: "Publish buyer-intent FAQ copy",
    description: `${REVIEW} Map audited buyer questions to on-site FAQ answers using only verified facts.`,
    codeSnippet: sanitizeSuggestedContent(body),
    language: "markdown",
  };
}

function metaTagsFix({ domain, brandName, category }) {
  const title = `${brandName} — ${category}`;
  const desc = `[One factual sentence about ${brandName} in ${category}. Do not invent rankings or awards.]`;
  const snippet = `<!-- ${REVIEW} -->
<title>${title}</title>
<meta name="description" content="${desc}" />
<link rel="canonical" href="https://${domain}/" />
`;
  return {
    category: FIX_CATEGORIES.META_TAGS,
    title: "Tighten title and meta description",
    description: `${REVIEW} Keep brand + category consistent in title/meta. Do not invent social proof.`,
    codeSnippet: sanitizeSuggestedContent(snippet),
    language: "html",
  };
}

/**
 * Persist action-engine drafts for an owned audit. Idempotent per audit + category.
 * @param {import("@prisma/client").PrismaClient} prisma
 */
export async function generateAuditFixes({ prisma, auditId, workspaceId, audit, diagnosisData }) {
  if (!prisma || !auditId || !workspaceId) {
    const err = new Error("auditId and workspaceId are required.");
    err.code = "VALIDATION";
    throw err;
  }

  const drafts = buildAuditFixDrafts({ audit, diagnosisData, pack: true });
  const created = [];
  for (const fix of drafts) {
    const row = await prisma.fix.upsert({
      where: { auditId_category: { auditId, category: fix.category } },
      create: {
        auditId,
        workspaceId,
        category: fix.category,
        title: fix.title,
        description: fix.description,
        codeSnippet: fix.codeSnippet,
        language: fix.language,
      },
      update: {
        title: fix.title,
        description: fix.description,
        codeSnippet: fix.codeSnippet,
        language: fix.language,
      },
    });
    created.push(row);
  }
  return created;
}

/**
 * Persist a per-issue narrative fix as a category row (issue id).
 */
export async function persistIssueFix({ prisma, auditId, workspaceId, issue, audit }) {
  const generated = generateFix(issue, audit);
  const category = `ISSUE:${String(issue.id).slice(0, 80)}`;
  const snippet = generated?.suggestedContent?.body || generated?.title || "";
  const row = await prisma.fix.upsert({
    where: { auditId_category: { auditId, category } },
    create: {
      auditId,
      workspaceId,
      category,
      title: generated.title,
      description: generated.why || generated.expectedImpact || generated.disclaimer,
      codeSnippet: snippet,
      language: "markdown",
    },
    update: {
      title: generated.title,
      description: generated.why || generated.expectedImpact || generated.disclaimer,
      codeSnippet: snippet,
      language: "markdown",
    },
  });
  return { fix: generated, persisted: publicFix(row) };
}

export function publicFix(row) {
  if (!row) return null;
  return {
    id: row.id,
    auditId: row.auditId,
    category: row.category,
    title: row.title,
    description: row.description,
    codeSnippet: row.codeSnippet,
    language: row.language,
    isApplied: row.isApplied === true,
    appliedAt: row.appliedAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
