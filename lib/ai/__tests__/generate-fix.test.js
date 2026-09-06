import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FIX_CATEGORIES,
  buildAuditFixDrafts,
  generateAuditFixes,
  hostFromDomain,
  persistIssueFix,
  publicFix,
} from "../generate-fix.js";
import { diagnoseAudit, generateFix } from "../diagnosis/index.js";

const weakAudit = {
  id: "audit_1",
  websiteId: "w1",
  website: { domain: "acmefoods.com", brandName: "Acme Foods", category: "organic snacks", url: "https://acmefoods.com" },
  mentionShare: 10,
  recommendationShare: 5,
  top3Share: 0,
  providerMetrics: {
    openai: { mentionShare: 0, recommendationShare: 0, top3Share: 0, tests: 2 },
    perplexity: { mentionShare: 0, recommendationShare: 0, top3Share: 0, tests: 2 },
    gemini: { mentionShare: 0, recommendationShare: 0, top3Share: 0, tests: 2 },
  },
  aiTests: [
    { provider: "openai", brandMentioned: false, error: null },
    { provider: "perplexity", brandMentioned: false, error: null },
    { provider: "gemini", brandMentioned: false, error: null },
  ],
  agenticScore: {
    found: { score: null, status: "not_evaluated" },
    understood: { score: 32, status: "ok", note: "No product schema or llms.txt found" },
    recommended: { score: 10, status: "ok" },
    bought: { score: null, status: "not_evaluated" },
    overall: { score: 25, status: "ok" },
  },
  competitors: [],
  questions: [
    { id: "q1", question: "best organic snacks", category: "discovery" },
    { id: "q2", question: "where to buy protein bars", category: "purchase" },
  ],
};

const healthyAudit = {
  id: "audit_healthy",
  websiteId: "w1",
  website: { domain: "https://www.strongbrand.com/shop", brandName: "Strong Brand", category: "tools" },
  mentionShare: 90,
  recommendationShare: 80,
  top3Share: 70,
  providerMetrics: {
    openai: { mentionShare: 90, recommendationShare: 80, top3Share: 70, tests: 2 },
    perplexity: { mentionShare: 90, recommendationShare: 80, top3Share: 70, tests: 2 },
    gemini: { mentionShare: 90, recommendationShare: 80, top3Share: 70, tests: 2 },
  },
  aiTests: [
    { provider: "openai", brandMentioned: true, recommended: true, error: null },
    { provider: "perplexity", brandMentioned: true, recommended: true, error: null },
    { provider: "gemini", brandMentioned: true, recommended: true, error: null },
  ],
  agenticScore: {
    found: { score: 90, status: "ok" },
    understood: { score: 88, status: "ok" },
    recommended: { score: 85, status: "ok" },
    bought: { score: 80, status: "ok" },
    overall: { score: 86, status: "ok" },
  },
  competitors: [],
  questions: [{ id: "q1", question: "what is Strong Brand", category: "discovery" }],
};

function createFakePrisma() {
  const rows = [];
  let n = 0;
  return {
    rows,
    fix: {
      async upsert({ where, create, update }) {
        const key = where.auditId_category;
        const found = rows.find((r) => r.auditId === key.auditId && r.category === key.category);
        if (!found) {
          const row = {
            id: `fix_${++n}`,
            isApplied: false,
            appliedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...create,
          };
          rows.push(row);
          return row;
        }
        Object.assign(found, update, { updatedAt: new Date() });
        return found;
      },
    },
  };
}

describe("hostFromDomain", () => {
  it("strips protocol, path, and www", () => {
    assert.equal(hostFromDomain("https://www.acmefoods.com/shop"), "acmefoods.com");
    assert.equal(hostFromDomain("acmefoods.com"), "acmefoods.com");
    assert.equal(hostFromDomain(""), "example.com");
  });
});

describe("buildAuditFixDrafts", () => {
  it("uses a real schema.org context, not a markdown link", () => {
    const drafts = buildAuditFixDrafts({ audit: weakAudit, pack: true });
    const jsonLd = drafts.find((d) => d.category === FIX_CATEGORIES.STRUCTURED_DATA);
    assert.ok(jsonLd);
    assert.match(jsonLd.codeSnippet, /"@context": "https:\/\/schema\.org"/);
    assert.equal(jsonLd.codeSnippet.includes("[https://schema.org](https://schema.org)"), false);
    assert.match(jsonLd.codeSnippet, /application\/ld\+json/);
  });

  it("does not invent support emails or Agenticaso legal URLs on the customer domain", () => {
    const drafts = buildAuditFixDrafts({ audit: weakAudit, pack: true });
    const joined = drafts.map((d) => d.codeSnippet).join("\n");
    assert.equal(/support@acmefoods\.com/i.test(joined), false);
    assert.equal(/refund-cancellation/i.test(joined), false);
    assert.match(joined, /\[your public support email\]/i);
    assert.match(joined, /review before publishing/i);
  });

  it("emits the four pack categories on explicit pack generation", () => {
    const drafts = buildAuditFixDrafts({ audit: healthyAudit, pack: true });
    const cats = drafts.map((d) => d.category).sort();
    assert.deepEqual(cats, ["FAQ", "LLMS_TXT", "META_TAGS", "STRUCTURED_DATA"].sort());
  });

  it("does not always-on emit a pack in gated mode for a healthy audit", () => {
    const drafts = buildAuditFixDrafts({ audit: healthyAudit, pack: false });
    assert.equal(drafts.some((d) => d.category === FIX_CATEGORIES.STRUCTURED_DATA), false);
    assert.equal(drafts.some((d) => d.category === FIX_CATEGORIES.LLMS_TXT), false);
  });

  it("offers structured data when understood score is weak", () => {
    const drafts = buildAuditFixDrafts({ audit: weakAudit, pack: false });
    assert.ok(drafts.some((d) => d.category === FIX_CATEGORIES.STRUCTURED_DATA));
    assert.ok(drafts.some((d) => d.category === FIX_CATEGORIES.LLMS_TXT));
  });
});

describe("generateAuditFixes persistence", () => {
  it("upserts pack rows by auditId + category", async () => {
    const prisma = createFakePrisma();
    const first = await generateAuditFixes({
      prisma,
      auditId: "audit_1",
      workspaceId: "ws_1",
      audit: weakAudit,
    });
    assert.equal(first.length, 4);
    const second = await generateAuditFixes({
      prisma,
      auditId: "audit_1",
      workspaceId: "ws_1",
      audit: weakAudit,
    });
    assert.equal(second.length, 4);
    assert.equal(prisma.rows.length, 4);
    assert.ok(publicFix(first[0]).codeSnippet);
    assert.equal(publicFix(first[0]).isApplied, false);
  });

  it("requires auditId and workspaceId", async () => {
    await assert.rejects(
      () => generateAuditFixes({ prisma: createFakePrisma(), auditId: "", workspaceId: "ws" }),
      (err) => err.code === "VALIDATION"
    );
  });
});

describe("per-issue generateFix still works alongside the pack", () => {
  it("keeps the dashboard narrative contract", () => {
    const { issues } = diagnoseAudit(weakAudit);
    const issue = issues.find((i) => i.id === "cross_ai_invisibility");
    const fix = generateFix(issue, weakAudit);
    assert.equal(fix.issueId, issue.id);
    assert.match(fix.disclaimer, /review before publishing/i);
    assert.ok(fix.suggestedContent?.body);
  });

  it("persists an ISSUE: category row without changing the narrative fix", async () => {
    const prisma = createFakePrisma();
    const { issues } = diagnoseAudit(weakAudit);
    const issue = issues.find((i) => i.id === "cross_ai_invisibility");
    const { fix, persisted } = await persistIssueFix({
      prisma,
      auditId: "audit_1",
      workspaceId: "ws_1",
      issue,
      audit: weakAudit,
    });
    assert.equal(fix.issueId, issue.id);
    assert.equal(persisted.category, "ISSUE:cross_ai_invisibility");
    assert.equal(prisma.rows.length, 1);
  });
});
