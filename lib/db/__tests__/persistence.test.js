import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { categorizeQuestion } from "../questions.js";
import {
  compareAudits,
  compareProviderMetrics,
  compareCompetitorSnapshots,
  metricDelta,
} from "../compare.js";
import { shouldStoreRawAnswers } from "../persist.js";

/** Minimal in-memory fake Prisma for persistence/ownership unit tests. */
function createFakeDb() {
  const state = {
    workspaces: [],
    websites: [],
    questions: [],
    audits: [],
    auditQuestions: [],
    aiTests: [],
    competitors: [],
    perceptions: [],
  };

  const genId = () => `id_${Math.random().toString(36).slice(2, 10)}`;

  return {
    state,
    workspace: {
      async upsert({ where, create, update }) {
        let row = state.workspaces.find((w) => w.clerkUserId === where.clerkUserId);
        if (!row) {
          row = { id: genId(), ...create, createdAt: new Date(), updatedAt: new Date() };
          state.workspaces.push(row);
        } else if (update?.email) {
          row.email = update.email;
        }
        return row;
      },
    },
    website: {
      async findUnique({ where }) {
        const { workspaceId, domain } = where.workspaceId_domain;
        return state.websites.find((w) => w.workspaceId === workspaceId && w.domain === domain) || null;
      },
      async findFirst({ where }) {
        return (
          state.websites.find((w) => {
            if (where.id && w.id !== where.id) return false;
            if (where.workspace?.clerkUserId) {
              const ws = state.workspaces.find((x) => x.id === w.workspaceId);
              if (!ws || ws.clerkUserId !== where.workspace.clerkUserId) return false;
            }
            return true;
          }) || null
        );
      },
      async create({ data }) {
        const row = { id: genId(), ...data, createdAt: new Date(), updatedAt: new Date() };
        state.websites.push(row);
        return row;
      },
      async update({ where, data }) {
        const row = state.websites.find((w) => w.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    buyerQuestion: {
      async upsert({ where, create, update }) {
        const { websiteId, question } = where.websiteId_question;
        let row = state.questions.find((q) => q.websiteId === websiteId && q.question === question);
        if (!row) {
          row = { id: genId(), ...create, createdAt: new Date(), updatedAt: new Date() };
          state.questions.push(row);
        } else {
          Object.assign(row, update);
        }
        return row;
      },
    },
    audit: {
      async create({ data, include }) {
        const id = genId();
        const {
          questions,
          aiTests,
          competitors,
          perception,
          ...auditData
        } = data;
        const audit = {
          id,
          ...auditData,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        state.audits.push(audit);

        const linkedQuestions = [];
        for (const q of questions?.create || []) {
          const link = { auditId: id, ...q };
          state.auditQuestions.push(link);
          const question = state.questions.find((x) => x.id === q.questionId);
          linkedQuestions.push({ ...link, question });
        }

        const tests = [];
        for (const t of aiTests?.create || []) {
          const row = { id: genId(), auditId: id, ...t, createdAt: new Date() };
          state.aiTests.push(row);
          tests.push(row);
        }

        const comps = [];
        for (const c of competitors?.create || []) {
          const row = { id: genId(), auditId: id, ...c };
          state.competitors.push(row);
          comps.push(row);
        }

        let perc = null;
        if (perception?.create) {
          perc = { id: genId(), auditId: id, ...perception.create, createdAt: new Date() };
          state.perceptions.push(perc);
        }

        if (!include) return audit;
        return {
          ...audit,
          questions: linkedQuestions,
          aiTests: tests,
          competitors: comps,
          perception: perc,
        };
      },
      async findFirst({ where, orderBy, include }) {
        let rows = state.audits.filter((a) => {
          if (where.websiteId && a.websiteId !== where.websiteId) return false;
          if (where.status && a.status !== where.status) return false;
          if (where.id?.not && a.id === where.id.not) return false;
          if (where.id && typeof where.id === "string" && a.id !== where.id) return false;
          return true;
        });
        if (orderBy?.completedAt === "desc") {
          rows = rows.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
        }
        const audit = rows[0];
        if (!audit) return null;
        if (!include) return audit;
        return {
          ...audit,
          competitors: state.competitors.filter((c) => c.auditId === audit.id),
          perception: state.perceptions.find((p) => p.auditId === audit.id) || null,
          aiTests: state.aiTests.filter((t) => t.auditId === audit.id),
          questions: state.auditQuestions
            .filter((q) => q.auditId === audit.id)
            .map((q) => ({
              ...q,
              question: state.questions.find((x) => x.id === q.questionId),
            })),
        };
      },
      async findMany() {
        return state.audits;
      },
    },
  };
}

describe("question categorization + duplicates", () => {
  it("categorizes buyer questions", () => {
    assert.equal(categorizeQuestion("where to buy organic tea online"), "purchase");
    assert.equal(categorizeQuestion("Acme vs Twinings comparison"), "comparison");
    assert.equal(categorizeQuestion("best organic tea brands"), "discovery");
  });

  it("upserts duplicates without creating a second row", async () => {
    const { upsertBuyerQuestions } = await import("../questions.js");
    const db = createFakeDb();
    const websiteId = "site1";
    db.state.websites.push({ id: websiteId, workspaceId: "ws1", domain: "a.com", url: "https://a.com" });

    const first = await upsertBuyerQuestions(db, {
      websiteId,
      questions: ["best tea", "best tea", "where to buy tea"],
    });
    assert.equal(first.length, 2);
    const second = await upsertBuyerQuestions(db, {
      websiteId,
      questions: ["best tea"],
    });
    assert.equal(second.length, 1);
    assert.equal(db.state.questions.length, 2);
    assert.equal(second[0].id, first[0].id);
  });
});

describe("historical comparison", () => {
  it("computes share deltas", () => {
    const d = metricDelta(57, 43);
    assert.deepEqual(d, { current: 57, previous: 43, delta: 14 });
  });

  it("computes provider movement", () => {
    const movement = compareProviderMetrics(
      {
        openai: { recommendationShare: 56, mentionShare: 60, top3Share: 40 },
        perplexity: { recommendationShare: 59, mentionShare: 70, top3Share: 50 },
        gemini: { recommendationShare: 44, mentionShare: 40, top3Share: 30 },
      },
      {
        openai: { recommendationShare: 41, mentionShare: 50, top3Share: 30 },
        perplexity: { recommendationShare: 62, mentionShare: 70, top3Share: 55 },
        gemini: { recommendationShare: 37, mentionShare: 35, top3Share: 20 },
      }
    );
    assert.equal(movement.openai.delta, 15);
    assert.equal(movement.perplexity.delta, -3);
    assert.equal(movement.gemini.delta, 7);
  });

  it("computes competitor movement without inventing names", () => {
    const rows = compareCompetitorSnapshots(
      [{ name: "Nike", recommendationShare: 40 }],
      [{ name: "Nike", recommendationShare: 55 }, { name: "Puma", recommendationShare: 20 }],
      30
    );
    const nike = rows.find((r) => r.competitor === "Nike");
    assert.ok(nike);
    assert.equal(nike.recommendationShareDelta, -15);
    assert.ok(rows.some((r) => r.competitor === "Puma"));
  });

  it("handles missing previous audit", () => {
    const result = compareAudits(
      {
        id: "a2",
        websiteId: "w",
        status: "completed",
        mentionShare: 50,
        recommendationShare: 40,
        top3Share: 30,
        providerMetrics: {},
        competitors: [],
      },
      null
    );
    assert.equal(result.missingPrevious, true);
    assert.equal(result.delta, null);
  });

  it("compares full audits including agentic scores", () => {
    const result = compareAudits(
      {
        id: "cur",
        websiteId: "w",
        status: "completed",
        mentionShare: 50,
        recommendationShare: 40,
        top3Share: 30,
        foundScore: 60,
        understoodScore: 55,
        recommendedScore: 40,
        boughtScore: null,
        overallScore: 50,
        providerMetrics: { openai: { recommendationShare: 40 } },
        competitors: [{ name: "Rival", recommendationShare: 70 }],
      },
      {
        id: "prev",
        websiteId: "w",
        status: "completed",
        mentionShare: 40,
        recommendationShare: 30,
        top3Share: 20,
        foundScore: 50,
        understoodScore: 50,
        recommendedScore: 30,
        boughtScore: null,
        overallScore: 40,
        providerMetrics: { openai: { recommendationShare: 25 } },
        competitors: [{ name: "Rival", recommendationShare: 80 }],
      }
    );
    assert.equal(result.delta.share.recommendationShare.delta, 10);
    assert.equal(result.delta.agenticScore.overall.delta, 10);
    assert.equal(result.delta.providers.openai.delta, 15);
  });
});

describe("audit persistence (fake db)", () => {
  it("persists audit, ai tests (including failures), competitors, and questions", async () => {
    const { persistCompletedAudit, getPreviousCompletedAudit } = await import("../persist.js");
    const db = createFakeDb();

    const v2Payload = {
      domain: "acmefoods.com",
      brand: "Acme Foods",
      category: "snacks",
      websiteUrl: "https://acmefoods.com",
      whatTheySell: "organic snacks",
      byQuestion: [
        {
          query: "best organic snacks",
          providers: [
            {
              provider: "openai",
              model: "mock",
              question: "best organic snacks",
              answer: "1. Acme Foods",
              brandMentioned: true,
              recommended: true,
              brandPosition: 1,
              competitors: [{ name: "Kind", position: 2 }],
              citations: [],
              confidence: 0.8,
              latencyMs: 100,
              error: null,
            },
            {
              provider: "gemini",
              model: "mock",
              question: "best organic snacks",
              answer: "",
              brandMentioned: false,
              recommended: false,
              brandPosition: null,
              competitors: [],
              citations: [],
              confidence: null,
              latencyMs: 5,
              error: "Missing GEMINI_API_KEY",
            },
          ],
        },
      ],
      intelligence: {
        overall: { mentionShare: 50 },
        shareOfVoice: { mentionShare: 50, recommendationShare: 50, top3Share: 50, totalTests: 1 },
        providers: {
          openai: { mentionShare: 100, recommendationShare: 100, top3Share: 100, tests: 1 },
          perplexity: { mentionShare: 0, recommendationShare: 0, top3Share: 0, tests: 0 },
          gemini: { mentionShare: 0, recommendationShare: 0, top3Share: 0, tests: 0 },
        },
        competitors: {
          list: [{ name: "Kind", mentions: 1, recommendations: 0, top3: 1, averagePosition: 2, mentionShare: 100, recommendationShare: 0, top3Share: 100 }],
          gap: { targetShare: 50, competitorShare: 0, gap: 50, competitorName: "Kind" },
        },
        perception: {
          brandThemes: ["organic"],
          aiThemes: ["organic"],
          missingThemes: [],
          unexpectedThemes: [],
          method: "deterministic_keywords",
        },
        agenticScore: {
          found: { score: null, status: "not_evaluated" },
          understood: { score: 40, status: "ok" },
          recommended: { score: 50, status: "ok" },
          bought: { score: null, status: "not_evaluated" },
          overall: { score: 45, status: "ok" },
        },
      },
    };

    const saved = await persistCompletedAudit(db, {
      clerkUserId: "user_1",
      email: "a@b.com",
      v2Payload,
    });

    assert.ok(saved.audit.id);
    assert.equal(saved.audit.status, "completed");
    assert.equal(db.state.aiTests.length, 2);
    assert.ok(db.state.aiTests.some((t) => t.error));
    assert.ok(db.state.aiTests.some((t) => t.brandMentioned && !t.error));
    assert.equal(db.state.competitors.length, 1);
    assert.equal(db.state.questions.length, 1);
    assert.ok(db.state.perceptions[0]);

    const previous = await getPreviousCompletedAudit(db, saved.website.id, {
      excludeAuditId: saved.audit.id,
    });
    assert.equal(previous, null);

    // Second audit → previous resolves
    const saved2 = await persistCompletedAudit(db, {
      clerkUserId: "user_1",
      v2Payload,
    });
    const prev2 = await getPreviousCompletedAudit(db, saved2.website.id, {
      excludeAuditId: saved2.audit.id,
    });
    assert.equal(prev2.id, saved.audit.id);
  });
});

describe("ownership checks", () => {
  it("rejects cross-user website access", async () => {
    const { getOrCreateWorkspace, getOrCreateWebsite, assertWebsiteOwnership } = await import(
      "../ownership.js"
    );
    const db = createFakeDb();
    // Extend fake for assertWebsiteOwnership include path
    const originalFindFirst = db.website.findFirst.bind(db.website);
    db.website.findFirst = async (args) => {
      const row = await originalFindFirst(args);
      if (!row) return null;
      const workspace = db.state.workspaces.find((w) => w.id === row.workspaceId);
      if (args.where?.workspace?.clerkUserId && workspace?.clerkUserId !== args.where.workspace.clerkUserId) {
        return null;
      }
      return { ...row, workspace };
    };

    const wsA = await getOrCreateWorkspace(db, { clerkUserId: "userA" });
    const site = await getOrCreateWebsite(db, {
      workspaceId: wsA.id,
      domain: "a.com",
      url: "https://a.com",
    });

    await assert.rejects(
      () => assertWebsiteOwnership(db, { websiteId: site.id, clerkUserId: "userB" }),
      (err) => err.code === "NOT_FOUND"
    );

    const owned = await assertWebsiteOwnership(db, { websiteId: site.id, clerkUserId: "userA" });
    assert.equal(owned.id, site.id);
  });
});

describe("raw answer retention flag", () => {
  it("respects STORE_RAW_ANSWERS", () => {
    const prev = process.env.STORE_RAW_ANSWERS;
    try {
      delete process.env.STORE_RAW_ANSWERS;
      assert.equal(shouldStoreRawAnswers(), true);
      process.env.STORE_RAW_ANSWERS = "false";
      assert.equal(shouldStoreRawAnswers(), false);
    } finally {
      if (prev === undefined) delete process.env.STORE_RAW_ANSWERS;
      else process.env.STORE_RAW_ANSWERS = prev;
    }
  });
});
