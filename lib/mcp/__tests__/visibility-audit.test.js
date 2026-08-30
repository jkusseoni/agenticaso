/**
 * MCP V1 Phase D — run_visibility_audit.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { currentBillingPeriod, getEntitlements, PLAN_IDS } from "../../billing/index.js";
import {
  RUN_VISIBILITY_AUDIT_TOOL,
  createApiKey,
  handleMcpHttp,
  runGetAuditTool,
  runListAuditsTool,
  runVisibilityAuditTool,
} from "../index.js";

const PREV_PEPPER = process.env.MCP_KEY_PEPPER;
const TEST_PEPPER = "unit-test-mcp-pepper-not-for-production";
const SITE = "https://mcp.test.agenticaso.com";
const SECRET = "SECRET_RAW_ANSWER";

before(() => {
  process.env.MCP_KEY_PEPPER = TEST_PEPPER;
});

after(() => {
  if (PREV_PEPPER == null) delete process.env.MCP_KEY_PEPPER;
  else process.env.MCP_KEY_PEPPER = PREV_PEPPER;
});

function genId() {
  return `id_${Math.random().toString(36).slice(2, 12)}`;
}

function createFakeDb() {
  const state = {
    workspaces: [],
    apiKeys: [],
    subscriptions: [],
    websites: [],
    usagePeriods: [],
    audits: [],
    questions: [],
    auditQuestions: [],
    aiTests: [],
    competitors: [],
    perceptions: [],
    rateBuckets: [],
  };

  const db = {
    state,
    addWorkspace(partial = {}) {
      const row = {
        id: partial.id || genId(),
        clerkUserId: partial.clerkUserId || `user_${genId()}`,
        email: partial.email || null,
        subscription: partial.subscription || null,
      };
      state.workspaces.push(row);
      if (row.subscription) {
        state.subscriptions.push({ ...row.subscription, workspaceId: row.id });
      }
      return row;
    },
    addWebsite(workspace, partial = {}) {
      const row = {
        id: partial.id || genId(),
        workspaceId: workspace.id,
        domain: partial.domain || "store.example",
        url: partial.url || "https://store.example",
        brandName: partial.brandName || "Store",
        category: partial.category || "snacks",
      };
      state.websites.push(row);
      return row;
    },
    workspace: {
      async findUnique({ where, include }) {
        const row = state.workspaces.find((w) => w.id === where.id);
        if (!row) return null;
        const out = { ...row };
        if (include?.subscription) {
          out.subscription = state.subscriptions.find((s) => s.workspaceId === row.id) || null;
        }
        if (include?._count) {
          out._count = { websites: state.websites.filter((w) => w.workspaceId === row.id).length };
        }
        return out;
      },
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
        if (where.workspaceId_domain) {
          const { workspaceId, domain } = where.workspaceId_domain;
          return state.websites.find((w) => w.workspaceId === workspaceId && w.domain === domain) || null;
        }
        if (where.id) return state.websites.find((w) => w.id === where.id) || null;
        return null;
      },
      async count({ where } = {}) {
        return state.websites.filter((w) => !where?.workspaceId || w.workspaceId === where.workspaceId).length;
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
    usagePeriod: {
      async upsert({ where, create }) {
        let row = state.usagePeriods.find(
          (p) =>
            p.workspaceId === where.workspaceId_periodStart.workspaceId &&
            p.periodStart.getTime() === where.workspaceId_periodStart.periodStart.getTime()
        );
        if (!row) {
          row = {
            id: genId(),
            aiTests: 0,
            aiTestsReserved: 0,
            audits: 0,
            monitoringRuns: 0,
            ...create,
          };
          state.usagePeriods.push(row);
        }
        return { ...row };
      },
      async findUnique({ where }) {
        if (where.id) return state.usagePeriods.find((p) => p.id === where.id) || null;
        return null;
      },
      async update({ where, data }) {
        const row = state.usagePeriods.find((p) => p.id === where.id);
        if (!row) return null;
        if (data.aiTestsReserved?.increment) row.aiTestsReserved += data.aiTestsReserved.increment;
        return { ...row };
      },
    },
    async $executeRaw(strings, ...values) {
      const sql = Array.isArray(strings) ? strings.join(" ") : String(strings);
      if (sql.includes('"aiTests" =') && sql.includes("GREATEST")) {
        const [reserved, actual, audits, monitoring, id] = values;
        const row = state.usagePeriods.find((p) => p.id === id);
        if (!row) return 0;
        row.aiTestsReserved = Math.max(0, (row.aiTestsReserved || 0) - Number(reserved));
        row.aiTests = (row.aiTests || 0) + Number(actual);
        row.audits = (row.audits || 0) + Number(audits);
        row.monitoringRuns = (row.monitoringRuns || 0) + Number(monitoring);
        return 1;
      }
      if (sql.includes("GREATEST")) {
        const [reserved, id] = values;
        const row = state.usagePeriods.find((p) => p.id === id);
        if (!row) return 0;
        row.aiTestsReserved = Math.max(0, (row.aiTestsReserved || 0) - Number(reserved));
        return 1;
      }
      const need = Number(values[0]) || 0;
      const id = values[1];
      const max = Number(values[values.length - 1]);
      const row = state.usagePeriods.find((p) => p.id === id);
      if (!row) return 0;
      if ((row.aiTests || 0) + (row.aiTestsReserved || 0) + need <= max) {
        row.aiTestsReserved += need;
        return 1;
      }
      return 0;
    },
    monitoring: { async count() { return 0; } },
    mcpRateBucket: {
      async upsert({ where, create, update }) {
        const key = where.workspaceId_action_windowStart;
        let row = state.rateBuckets.find(
          (r) =>
            r.workspaceId === key.workspaceId &&
            r.action === key.action &&
            new Date(r.windowStart).getTime() === new Date(key.windowStart).getTime()
        );
        if (!row) {
          row = { id: genId(), count: 0, updatedAt: new Date(), ...create };
          state.rateBuckets.push(row);
          return { ...row };
        }
        if (update?.count?.increment) row.count += update.count.increment;
        row.updatedAt = new Date();
        return { ...row };
      },
    },
    apiKey: {
      async create({ data }) {
        const row = {
          id: genId(),
          status: "active",
          lastUsedAt: null,
          revokedAt: null,
          expiresAt: null,
          createdAt: new Date(),
          ...data,
        };
        state.apiKeys.push(row);
        return { ...row };
      },
      async findUnique({ where, include }) {
        let row = null;
        if (where.keyHash) row = state.apiKeys.find((k) => k.keyHash === where.keyHash) || null;
        else if (where.id) row = state.apiKeys.find((k) => k.id === where.id) || null;
        if (!row) return null;
        if (include?.workspace) {
          const workspace = state.workspaces.find((w) => w.id === row.workspaceId) || null;
          return { ...row, workspace };
        }
        return { ...row };
      },
      async update({ where, data }) {
        const row = state.apiKeys.find((k) => k.id === where.id);
        if (!row) return null;
        Object.assign(row, data);
        return { ...row };
      },
      async count({ where }) {
        return state.apiKeys.filter((k) => {
          if (where.workspaceId && k.workspaceId !== where.workspaceId) return false;
          if (where.status && k.status !== where.status) return false;
          return true;
        }).length;
      },
    },
    audit: {
      async create({ data, include }) {
        const { questions, aiTests, competitors, perception, ...auditData } = data;
        const audit = { id: genId(), ...auditData, createdAt: new Date(), updatedAt: new Date() };
        state.audits.push(audit);

        const linkedQuestions = [];
        for (const q of questions?.create || []) {
          const link = { auditId: audit.id, ...q };
          state.auditQuestions.push(link);
          const question = state.questions.find((x) => x.id === q.questionId);
          linkedQuestions.push({ ...link, question });
        }
        const tests = [];
        for (const t of aiTests?.create || []) {
          const row = { id: genId(), auditId: audit.id, ...t, createdAt: new Date() };
          state.aiTests.push(row);
          tests.push(row);
        }
        const comps = [];
        for (const c of competitors?.create || []) {
          const row = { id: genId(), auditId: audit.id, ...c };
          state.competitors.push(row);
          comps.push(row);
        }
        let perc = null;
        if (perception?.create) {
          perc = { id: genId(), auditId: audit.id, ...perception.create, createdAt: new Date() };
          state.perceptions.push(perc);
        }
        if (!include) return audit;
        return { ...audit, questions: linkedQuestions, aiTests: tests, competitors: comps, perception: perc };
      },
      async findMany({ where, orderBy, take, include }) {
        const clerkUserId = where?.website?.workspace?.clerkUserId;
        const websiteId = where?.website?.id;
        let rows = state.audits.filter((a) => {
          const site = state.websites.find((w) => w.id === a.websiteId);
          const ws = state.workspaces.find((w) => w.id === site?.workspaceId);
          if (clerkUserId && ws?.clerkUserId !== clerkUserId) return false;
          if (websiteId && a.websiteId !== websiteId) return false;
          return true;
        });
        if (orderBy?.completedAt === "desc") {
          rows = [...rows].sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
        }
        if (take) rows = rows.slice(0, take);
        return rows.map((a) => {
          const site = state.websites.find((w) => w.id === a.websiteId);
          const out = { ...a, website: site };
          if (include?.competitors) {
            out.competitors = state.competitors.filter((c) => c.auditId === a.id).slice(0, include.competitors.take || 5);
          }
          return out;
        });
      },
      async findFirst({ where, orderBy, include }) {
        let rows = state.audits.filter((a) => {
          if (where?.id && typeof where.id === "string" && a.id !== where.id) return false;
          if (where?.id?.not && a.id === where.id.not) return false;
          if (where?.websiteId && a.websiteId !== where.websiteId) return false;
          if (where?.status && a.status !== where.status) return false;
          const site = state.websites.find((w) => w.id === a.websiteId);
          const ws = state.workspaces.find((w) => w.id === site?.workspaceId);
          if (where?.website?.workspace?.clerkUserId && ws?.clerkUserId !== where.website.workspace.clerkUserId) {
            return false;
          }
          return true;
        });
        if (orderBy?.completedAt === "desc") {
          rows = [...rows].sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
        }
        const audit = rows[0];
        if (!audit) return null;
        const site = state.websites.find((w) => w.id === audit.websiteId);
        if (!include) return { ...audit, website: site };
        return {
          ...audit,
          website: site,
          competitors: state.competitors.filter((c) => c.auditId === audit.id),
          perception: state.perceptions.find((p) => p.auditId === audit.id) || null,
          aiTests: state.aiTests.filter((t) => t.auditId === audit.id),
          questions: state.auditQuestions
            .filter((q) => q.auditId === audit.id)
            .map((q) => ({ ...q, question: state.questions.find((x) => x.id === q.questionId) })),
        };
      },
    },
  };
  return db;
}

const freeEnt = getEntitlements(null);
const proEnt = getEntitlements({
  plan: PLAN_IDS.PRO,
  status: "active",
  provider: "paddle",
  providerSubscriptionId: "sub_verified_test",
  currentPeriodEnd: new Date(Date.now() + 86400_000),
});

function seedUsage(db, workspaceId, { aiTests = 0, aiTestsReserved = 0 } = {}) {
  const { periodStart, periodEnd } = currentBillingPeriod();
  const row = {
    id: genId(),
    workspaceId,
    periodStart,
    periodEnd,
    aiTests,
    aiTestsReserved,
    audits: 0,
    monitoringRuns: 0,
  };
  db.state.usagePeriods.push(row);
  return row;
}

function mockProviders({ errorOn } = {}) {
  const competitors = [
    { name: "Kind", position: 1 },
    { name: "RXBAR", position: 2 },
    { name: "Clif", position: 3 },
    { name: "ONE", position: 4 },
    { name: "Quest", position: 5 },
  ];
  return async ({ buyerQuestion }) =>
    ["openai", "perplexity", "gemini"].map((provider) => {
      if (provider === errorOn) {
        return {
          provider,
          model: "mock",
          question: buyerQuestion,
          answer: "",
          brandMentioned: false,
          brandPosition: null,
          recommended: false,
          competitors: [],
          citations: [],
          confidence: null,
          latencyMs: 1,
          error: "provider_unavailable",
        };
      }
      return {
        provider,
        model: "mock",
        question: buyerQuestion,
        answer: SECRET,
        brandMentioned: true,
        brandPosition: 2,
        recommended: false,
        competitors,
        citations: [],
        confidence: 0.8,
        latencyMs: 1,
        error: null,
      };
    });
}

function mockSiteSignals() {
  return async () => ({
    ok: true,
    title: "Acme Foods",
    ogTitle: "Acme Foods",
    desc: "organic snacks",
    h1: "Acme",
    bodyText: "organic snacks protein bars",
  });
}

function auditDeps(overrides = {}) {
  return {
    siteSignals: mockSiteSignals(),
    runAllProviders: mockProviders(),
    identifyBrand: async () => ({
      brand: "Acme Foods",
      category: "snacks",
      whatTheySell: "bars",
      isEcommerce: true,
    }),
    generateBuyerQueries: async () => ["best organic snacks"],
    ...overrides,
  };
}

function parseTool(result) {
  const text = result.content?.[0]?.text;
  return { isError: result.isError === true, body: JSON.parse(text) };
}

function usageOf(db, workspaceId) {
  return db.state.usagePeriods.find((p) => p.workspaceId === workspaceId) || { aiTests: 0, aiTestsReserved: 0, audits: 0 };
}

async function setup(plan = "free") {
  const db = createFakeDb();
  const subscription = plan === "pro"
    ? { plan: PLAN_IDS.PRO, status: "active", provider: "paddle", providerSubscriptionId: "sub_verified_test", currentPeriodEnd: new Date(Date.now() + 86400_000) }
    : null;
  const ws = db.addWorkspace({ subscription });
  const entitlements = plan === "pro" ? proEnt : freeEnt;
  const created = await createApiKey(db, { workspaceId: ws.id, entitlements, name: "mcp" });
  const ctx = {
    db,
    workspace: ws,
    entitlements,
    visibilityAudit: auditDeps(),
  };
  return { db, ws, token: created.key, ctx, entitlements };
}

async function mcpCall(name, args, { token, db, visibilityAudit }) {
  const req = new Request("https://mcp.test.agenticaso.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args || {} },
    }),
  });
  return handleMcpHttp(req, { db, enabled: true, siteUrl: SITE, visibilityAudit });
}

describe("run_visibility_audit", () => {
  it("runs a successful Free audit and returns compact results without raw answers", async () => {
    const a = await setup("free");
    const out = parseTool(
      await runVisibilityAuditTool(a.ctx, {
        url: "https://acmefoods.com",
        brand: "Acme Foods",
        question: "best organic snacks",
        plan: "pro",
        isPaid: true,
        quota: 9999,
      })
    );
    assert.equal(out.isError, false);
    assert.ok(out.body.auditId);
    assert.equal(out.body.domain, "acmefoods.com");
    assert.equal(out.body.brand, "Acme Foods");
    assert.equal(typeof out.body.overall.score, "number");
    assert.equal(typeof out.body.mentionShare, "number");
    assert.equal(typeof out.body.recommendationShare, "number");
    assert.equal(typeof out.body.top3Share, "number");
    assert.equal(out.body.topCompetitors.length, 3);
    assert.equal(out.body.usage.aiTestsCharged, 3);
    assert.equal(out.body.usage.expectedAiTests, 3);
    assert.equal(JSON.stringify(out.body).includes(SECRET), false);
    assert.equal("byQuestion" in out.body, false);
    assert.equal("providers" in out.body, false);
    const persisted = a.db.state.aiTests[0];
    assert.equal(persisted.answer, SECRET);
  });

  it("runs a successful Pro audit with the full competitor set", async () => {
    const a = await setup("pro");
    const out = parseTool(
      await runVisibilityAuditTool(a.ctx, {
        url: "https://acmefoods.com",
        brand: "Acme Foods",
        question: "best organic snacks",
      })
    );
    assert.equal(out.isError, false);
    assert.ok(out.body.topCompetitors.length > 3);
    assert.equal(out.body.usage.aiTestsCharged, 3);
    assert.equal(JSON.stringify(out.body).includes(SECRET), false);
  });

  it("rejects insufficient AI quota with upgradePayload", async () => {
    const a = await setup("free");
    seedUsage(a.db, a.ws.id, { aiTests: 44 });
    let providersCalled = 0;
    a.ctx.visibilityAudit = auditDeps({
      runAllProviders: async () => {
        providersCalled += 1;
        return [];
      },
    });
    const out = parseTool(
      await runVisibilityAuditTool(a.ctx, {
        url: "https://acmefoods.com",
        brand: "Acme Foods",
        question: "best organic snacks",
      })
    );
    assert.equal(out.isError, true);
    assert.equal(out.body.code, "ENTITLEMENT_REQUIRED");
    assert.equal(out.body.upgrade, true);
    assert.equal(out.body.feature, "aiTests");
    assert.equal(out.body.suggestedPlan, "pro");
    assert.equal(providersCalled, 0);
    assert.equal(usageOf(a.db, a.ws.id).aiTestsReserved, 0);
  });

  it("enforces the Free website-slot limit even if the client sends plan=pro", async () => {
    const a = await setup("free");
    a.db.addWebsite(a.ws, { domain: "already-used.com" });
    a.ctx.workspace._count = { websites: 1 };
    const out = parseTool(
      await runVisibilityAuditTool(a.ctx, {
        url: "https://newstore.example.com",
        brand: "New Store",
        question: "best snacks",
        plan: "pro",
        isPaid: true,
      })
    );
    assert.equal(out.isError, true);
    assert.equal(out.body.code, "ENTITLEMENT_REQUIRED");
    assert.equal(out.body.feature, "websites");
    assert.equal(out.body.upgrade, true);
    assert.equal(out.body.suggestedPlan, "pro");
  });

  it("rejects invalid and private URLs without calling providers", async () => {
    const a = await setup("free");
    let called = 0;
    a.ctx.visibilityAudit = auditDeps({
      siteSignals: async () => {
        called += 1;
        return { ok: false };
      },
      runAllProviders: async () => {
        called += 1;
        return [];
      },
    });
    for (const url of ["http://localhost", "http://127.0.0.1", "http://192.168.1.9", "ftp://example.com", ""]) {
      const out = parseTool(await runVisibilityAuditTool(a.ctx, { url }));
      assert.equal(out.isError, true);
      assert.equal(out.body.code, "INVALID_URL");
    }
    assert.equal(called, 0);
  });

  it("releases the reservation when the provider run throws", async () => {
    const a = await setup("free");
    a.ctx.visibilityAudit = auditDeps({
      runAllProviders: async () => {
        throw new Error("providers exploded");
      },
    });
    const out = parseTool(
      await runVisibilityAuditTool(a.ctx, {
        url: "https://acmefoods.com",
        brand: "Acme Foods",
        question: "best organic snacks",
      })
    );
    assert.equal(out.isError, true);
    assert.equal(out.body.code, "AUDIT_FAILED");
    const usage = usageOf(a.db, a.ws.id);
    assert.equal(usage.aiTestsReserved, 0);
    assert.equal(usage.aiTests, 0);
    assert.equal(usage.audits, 0);
  });

  it("commits only successful billable providers and releases unused reservation", async () => {
    const a = await setup("free");
    a.ctx.visibilityAudit = auditDeps({
      runAllProviders: mockProviders({ errorOn: "gemini" }),
    });
    const out = parseTool(
      await runVisibilityAuditTool(a.ctx, {
        url: "https://acmefoods.com",
        brand: "Acme Foods",
        question: "best organic snacks",
      })
    );
    assert.equal(out.isError, false);
    assert.equal(out.body.usage.aiTestsCharged, 2);
    assert.equal(out.body.usage.expectedAiTests, 3);
    const usage = usageOf(a.db, a.ws.id);
    assert.equal(usage.aiTests, 2);
    assert.equal(usage.aiTestsReserved, 0);
    assert.equal(usage.audits, 1);
  });

  it("commits usage on a successful run", async () => {
    const a = await setup("free");
    const out = parseTool(
      await runVisibilityAuditTool(a.ctx, {
        url: "https://acmefoods.com",
        brand: "Acme Foods",
        question: "best organic snacks",
      })
    );
    assert.equal(out.isError, false);
    const usage = usageOf(a.db, a.ws.id);
    assert.equal(usage.aiTests, 3);
    assert.equal(usage.aiTestsReserved, 0);
    assert.equal(usage.audits, 1);
  });

  it("persists into the authenticated workspace only", async () => {
    const a = await setup("free");
    const out = parseTool(
      await runVisibilityAuditTool(a.ctx, {
        url: "https://acmefoods.com",
        brand: "Acme Foods",
        question: "best organic snacks",
      })
    );
    assert.equal(out.isError, false);

    const other = a.db.addWorkspace({ clerkUserId: "intruder" });
    const steal = parseTool(
      await runGetAuditTool({ db: a.db, workspace: other, entitlements: freeEnt }, { auditId: out.body.auditId })
    );
    assert.equal(steal.isError, true);
    assert.equal(steal.body.code, "NOT_FOUND");

    const listed = parseTool(await runListAuditsTool({ db: a.db, workspace: other, entitlements: freeEnt }, {}));
    assert.equal(listed.body.audits.some((row) => row.id === out.body.auditId), false);

    const own = parseTool(await runGetAuditTool(a.ctx, { auditId: out.body.auditId }));
    assert.equal(own.isError, false);
    assert.equal(JSON.stringify(own.body).includes(SECRET), false);
    assert.equal(own.body.aiTests.every((t) => !Object.prototype.hasOwnProperty.call(t, "answer")), true);
  });

  it("HTTP tools/call succeeds with a Bearer key and injected providers", async () => {
    const a = await setup("free");
    const res = await mcpCall(
      RUN_VISIBILITY_AUDIT_TOOL,
      { url: "https://acmefoods.com", brand: "Acme Foods", question: "best organic snacks" },
      { token: a.token, db: a.db, visibilityAudit: auditDeps() }
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(await res.text());
    assert.notEqual(body.result?.isError, true);
    const payload = JSON.parse(body.result.content[0].text);
    assert.ok(payload.auditId);
    assert.equal(payload.domain, "acmefoods.com");
    assert.equal(JSON.stringify(payload).includes(SECRET), false);
  });
});
