/**
 * Evidence-based fix generator.
 * Templates only — no invented stats, awards, customers, or integrations.
 */

const REVIEW_BANNER = "Suggested — review before publishing.";

const FORBIDDEN_CLAIM_PATTERNS = [
  /\b\d+%\b/,
  /\baward(ed|s)?\b/i,
  /\bcertified\b/i,
  /\b#1\b/,
  /\bbest[- ]selling\b/i,
  /\bguaranteed\b/i,
  /\b\d{2,}\+?\s*(customers|reviews|users)\b/i,
];

/**
 * Strip / reject unsafe invented claims from suggested copy.
 * @param {string} text
 */
export function sanitizeSuggestedContent(text) {
  let out = String(text || "");
  for (const re of FORBIDDEN_CLAIM_PATTERNS) {
    out = out.replace(re, "[verify before publishing]");
  }
  // Never allow fabricated review counts / testimonials markers
  out = out.replace(/\b(testimonial|customer said|as seen in)\b/gi, "[remove unverified claim]");
  return out.trim();
}

/**
 * @param {object} issue
 * @param {object} audit
 */
export function generateFix(issue, audit) {
  if (!issue?.id) {
    const err = new Error("issueId is required.");
    err.code = "VALIDATION";
    throw err;
  }

  const brand = audit?.website?.brandName || audit?.website?.domain || "your brand";
  const category = audit?.website?.category || audit?.intelligenceSummary?.overall?.category || "your category";
  const domain = audit?.website?.domain || "your site";
  const missingThemes = (audit?.perception?.missingThemes || audit?.intelligenceSummary?.perception?.missingThemes || []).slice(0, 5);
  const competitor = issue.relatedMetrics?.competitorName || audit?.intelligenceSummary?.competitorGap?.competitorName;

  const base = {
    issueId: issue.id,
    reviewRequired: true,
    disclaimer: REVIEW_BANNER,
  };

  const builders = {
    cross_ai_invisibility: () =>
      pack(base, {
        title: `Create a clear “What ${brand} is” entity section`,
        why: issue.evidence?.join(" ") || issue.description,
        expectedImpact: "Improve brand mention rate across AI providers that currently omit you.",
        implementationSteps: [
          `Add a dedicated “About ${brand}” / “What we offer” section on the homepage and a key category page.`,
          `State the category plainly (${category}) and the primary use cases buyers ask AI about.`,
          "Use consistent brand naming (legal name + common short name) in title, H1, and first paragraph.",
          "Add an FAQ that answers discovery questions from this audit.",
          "Internally link that section from product and category pages.",
        ],
        suggestedContent: safeSection(
          brand,
          category,
          `## What ${brand} offers\n\n${brand} provides products/services in ${category}.\n\nUse this section to explain who it is for and what problem it solves — using only facts you can verify on ${domain}.\n\n### FAQ\n**What is ${brand}?**\n${brand} is a ${category} brand. [Add one verified sentence.]\n\n**Who is it for?**\n[Describe your real customer segments — do not invent personas.]`
        ),
        verificationPlan: [
          "Re-audit the same buyer question set.",
          "Check mentionShare and per-provider mention results for OpenAI, Perplexity, and Gemini.",
          'Compare with wording: "Observed change after re-audit." — do not assume causation unless you recorded the fix application.',
        ],
      }),

    low_recommendation_share: () =>
      pack(base, {
        title: "Publish comparison-ready category guidance",
        why: issue.evidence?.join(" ") || issue.description,
        expectedImpact: "Increase recommendationShare on buyer questions where AI currently picks rivals.",
        implementationSteps: [
          `Create a “How to choose ${category}” guide with your real differentiators only.`,
          "Add a comparison table using attributes you actually support (no fabricated competitor claims).",
          "Add FAQ entries matching purchase/comparison questions from the audit.",
          "Ensure product pages restate the same differentiators in the first viewport.",
        ],
        suggestedContent: safeSection(
          brand,
          category,
          `## How to choose ${category}\n\nWhen evaluating options in ${category}, consider: [list 3–5 attributes you truly offer].\n\n### Where ${brand} fits\n${brand} focuses on [verified differentiator]. We do not claim to be best for every use case.\n\n### FAQ\n**When should I choose ${brand}?**\nChoose ${brand} if you need [verified use case].`
        ),
        verificationPlan: [
          "Re-run the same comparison and purchase buyer questions.",
          "Track recommendationShare and top3Share deltas after re-audit.",
        ],
      }),

    mentioned_not_ranked: () =>
      pack(base, {
        title: "Strengthen ranking proof points (without inventing social proof)",
        why: issue.evidence?.join(" ") || issue.description,
        expectedImpact: "Move from mere mentions into top-3 placements where evidence supports it.",
        implementationSteps: [
          "Lead with specific, verifiable product attributes AI can quote.",
          "Add structured specs (materials, dimensions, compatibility) you already have.",
          "Clarify ideal customer and non-ideal customer to improve ranking relevance.",
          "Do not invent review counts or awards.",
        ],
        suggestedContent: safeSection(
          brand,
          category,
          `## Why teams consider ${brand}\n\n- [Verified attribute 1]\n- [Verified attribute 2]\n- [Verified attribute 3]\n\nOnly publish bullets you can support with product pages or docs on ${domain}.`
        ),
        verificationPlan: ["Re-audit and compare top3Share and brandPosition across providers."],
      }),

    perception_missing_themes: () =>
      pack(base, {
        title: "Align public content with missing positioning themes",
        why: `Missing themes from perception analysis: ${missingThemes.join(", ") || "see evidence"}.`,
        expectedImpact: "Help AI associate the brand with intended themes on future audits.",
        implementationSteps: [
          `Add a short section that naturally uses these themes only if true: ${missingThemes.join(", ") || "[themes]"}.`,
          "Repeat the theme once in title/meta description if accurate.",
          "Add one FAQ that uses the theme language buyers might ask AI.",
          "Do not force themes that are not real product attributes.",
        ],
        suggestedContent: safeSection(
          brand,
          category,
          `## ${missingThemes[0] || "Positioning"} at ${brand}\n\n${brand}'s ${category} offering emphasizes ${missingThemes.slice(0, 3).join(", ") || "[verified themes]"} — only include attributes that are true.\n\n### FAQ\n**Does ${brand} offer ${missingThemes[0] || "this attribute"}?**\n[Yes/No with one factual sentence.]`
        ),
        verificationPlan: [
          "Re-audit and inspect perception.missingThemes / aiThemes.",
          "Confirm whether previously missing themes appear in AI answers.",
        ],
      }),

    perception_unexpected_themes: () =>
      pack(base, {
        title: "Clarify on-message positioning (reduce off-theme associations)",
        why: issue.evidence?.join(" ") || issue.description,
        expectedImpact: "Reduce unexpected AI themes by tightening public messaging.",
        implementationSteps: [
          "Audit homepage/product copy for phrases that may pull off-theme associations.",
          "Replace ambiguous category wording with precise, verified terminology.",
          "Keep a single primary category phrase consistent across key pages.",
        ],
        suggestedContent: safeSection(
          brand,
          category,
          `## Our focus\n\n${brand} focuses on ${category}. If a page currently mixes unrelated categories, rewrite it to one clear offer.`
        ),
        verificationPlan: ["Re-audit and compare unexpectedThemes list length and contents."],
      }),

    weak_entity_clarity: () =>
      pack(base, {
        title: "Clarify organization and product identity",
        why: issue.evidence?.join(" ") || issue.description,
        expectedImpact: "Improve Understood score and AI’s ability to map the brand entity.",
        implementationSteps: [
          "Add Organization/brand name, what you sell, and who it’s for above the fold.",
          "Ensure product names are consistent with category language.",
          "Add or improve machine-readable product/organization markup if you already use it — do not claim schema exists if it doesn’t.",
        ],
        suggestedContent: safeSection(
          brand,
          category,
          `## About ${brand}\n\n**Brand:** ${brand}\n**Category:** ${category}\n**Site:** ${domain}\n\n[One paragraph: what you sell and for whom — facts only.]`
        ),
        verificationPlan: ["Re-audit and review agenticScore.understood."],
      }),

    incomplete_structured_signals: () =>
      pack(base, {
        title: "Strengthen machine-readable product/organization signals",
        why: issue.evidence?.join(" ") || issue.description,
        expectedImpact: "Help agents parse catalog/entity data more reliably when structured data is present.",
        implementationSteps: [
          "Verify whether Product/Organization structured data already exists; add only what you can maintain.",
          "Ensure price/availability fields are accurate if Offer markup is used.",
          "Consider an llms.txt summary with factual brand/category links.",
          "Do not invent rich-result eligibility claims.",
        ],
        suggestedContent: safeSection(
          brand,
          category,
          `# llms.txt (draft — review)\n\nBrand: ${brand}\nCategory: ${category}\nSite: https://${domain}\n\nSummary: [One factual sentence.]\nKey pages:\n- /\n- [category URL]\n- [about URL]`
        ),
        verificationPlan: ["Re-audit Understood dimension; optionally re-run Engine 1 site scan for schema presence."],
      }),

    commerce_signals_unavailable: () =>
      pack(base, {
        title: "Supply commerce-readiness signals for future audits",
        why: issue.evidence?.join(" ") || issue.description,
        expectedImpact: "Allow Bought to be evaluated instead of not_evaluated.",
        implementationSteps: [
          "If you have offers, expose accurate price/availability where appropriate.",
          "If on Shopify or agent-checkout rails, ensure product feed endpoints are reachable.",
          "Pass commerceSignals on future audits only when true.",
        ],
        suggestedContent: safeSection(
          brand,
          category,
          `## Purchase information\n\nPublish clear pricing and availability on product pages. Do not invent discounts or stock claims.`
        ),
        verificationPlan: ["Re-audit with real commerceSignals if available; confirm bought.status moves from not_evaluated."],
      }),

    weak_commerce_readiness: () =>
      pack(base, {
        title: "Improve evaluated commerce-readiness signals",
        why: issue.evidence?.join(" ") || issue.description,
        expectedImpact: "Raise Bought score when agents try to complete a purchase path.",
        implementationSteps: [
          "Ensure offer/price data is accurate and crawlable.",
          "Expose a machine-readable product feed if you operate one.",
          "Do not claim ACP/UCP support unless actually implemented.",
        ],
        suggestedContent: safeSection(
          brand,
          category,
          `## How to buy\n\nExplain real purchase steps for ${brand}. Link to actual product/checkout pages only.`
        ),
        verificationPlan: ["Re-audit and compare bought.score."],
      }),

    missing_comparison_content: () =>
      pack(base, {
        title: competitor
          ? `Create a factual comparison page vs alternatives (including ${competitor} only with verified differences)`
          : "Create a factual comparison page for your category",
        why: issue.evidence?.join(" ") || issue.description,
        expectedImpact: "Improve recommendationShare on comparison-style buyer questions.",
        implementationSteps: [
          "List attributes you can verify side-by-side.",
          "Do not invent competitor weaknesses or unverified competitor features.",
          "Link the comparison page from category and product pages.",
          "Add FAQ: “How does this compare to alternatives?”",
        ],
        suggestedContent: safeSection(
          brand,
          category,
          `## ${brand} vs alternatives\n\nUse this page to compare attributes you can prove.\n\n| Attribute | ${brand} | Typical alternatives |\n| --- | --- | --- |\n| [Attribute] | [Your verified value] | [Neutral description] |\n\nOnly fill cells with facts.`
        ),
        verificationPlan: [
          "Re-audit comparison questions.",
          `Observe recommendationShare gap vs ${competitor || "top competitor"} after re-audit.`,
        ],
      }),

    weak_buyer_intent_coverage: () =>
      pack(base, {
        title: "Expand FAQ and intent pages for audited buyer questions",
        why: issue.evidence?.join(" ") || issue.description,
        expectedImpact: "Improve recommendation outcomes on purchase/problem/comparison intents.",
        implementationSteps: [
          "Map each audited purchase/problem/comparison question to a page section or FAQ.",
          "Answer with verified product facts only.",
          "Keep terminology consistent with how buyers ask AI.",
        ],
        suggestedContent: safeSection(
          brand,
          category,
          `## FAQ for ${category} buyers\n\n${(audit.questions || [])
            .filter((q) => ["purchase", "problem", "comparison"].includes(q.category))
            .slice(0, 3)
            .map((q) => `### ${q.question}\n[Answer with verified facts about ${brand}.]\n`)
            .join("\n") || `### Common questions\n[Add verified answers.]`}`
        ),
        verificationPlan: ["Re-audit the same intent questions and compare recommendationShare."],
      }),
  };

  // Competitor gap ids are dynamic
  if (issue.id?.startsWith("competitor_gap_")) {
    return builders.missing_comparison_content
      ? builders.missing_comparison_content()
      : defaultFix(base, issue, brand, category);
  }

  const build = builders[issue.id];
  if (build) return build();
  return defaultFix(base, issue, brand, category);
}

function pack(base, fields) {
  return {
    ...base,
    title: fields.title,
    why: fields.why,
    expectedImpact: fields.expectedImpact,
    implementationSteps: fields.implementationSteps,
    suggestedContent: {
      banner: REVIEW_BANNER,
      body: sanitizeSuggestedContent(fields.suggestedContent),
    },
    verificationPlan: fields.verificationPlan,
  };
}

function safeSection(_brand, _category, body) {
  return `${REVIEW_BANNER}\n\n${body}`;
}

function defaultFix(base, issue, brand, category) {
  return pack(base, {
    title: `Address: ${issue.title}`,
    why: (issue.evidence || []).join(" ") || issue.description,
    expectedImpact: issue.impact || "Improve AI visibility signals related to this issue.",
    implementationSteps: [
      `Document the evidence for “${issue.title}” with your team.`,
      `Update ${brand} pages in ${category} using only verified facts.`,
      "Re-audit to measure observed change.",
    ],
    suggestedContent: `${REVIEW_BANNER}\n\n## Next step for ${brand}\n\nReview the issue evidence and publish factual clarifications on your site. Do not invent reviews, awards, or statistics.`,
    verificationPlan: ["Run Re-audit and compare share metrics with prior snapshot."],
  });
}

/**
 * Ensure suggested content does not contain common hallucinated claim patterns (post-sanitize check).
 */
export function assertSafeSuggestion(fix) {
  const body = fix?.suggestedContent?.body || "";
  const banned = [
    /\bguaranteed\b/i,
    /\bawarded\b/i,
    /\b\d{3,}\s*customers\b/i,
  ];
  return !banned.some((re) => re.test(body));
}
