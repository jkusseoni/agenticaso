/**
 * MCP V1 Phase C - scan_store, list_audits, get_audit, diagnose_audit.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { getEntitlements, PLAN_IDS } from "../../billing/index.js";
import { _resetRateLimitsForTests } from "../rate-limit.js";
import {
  DIAGNOSE_AUDIT_TOOL,
  GET_AUDIT_TOOL,
  LIST_AUDITS_TOOL,
  SCAN_STORE_TOOL,
  consumeMcpRateLimit,
  createApiKey,
  handleMcpHttp,
  runDiagnoseAuditTool,
  runGetAuditTool,
  runListAuditsTool,
  runScanStoreTool,
} from "../index.js";

const PREV_PEPPER = process.env.MCP_KEY_PEPPER;
const TEST_PEPPER = "unit-test-mcp-pepper-not-for-production";
const SITE = "https://mcp.test.agenticaso.com";

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
    addAudit(website, partial = {}) {
      const row = {
        id: partial.id || genId(),
        websiteId: website.id,
        website,
        status: "completed",
        startedAt: new Date("2026-08-01T00:00:00Z"),
        completedAt: partial.completedAt || new Date("2026-08-02T00:00:00Z"),
        mentionShare: 10,
        recommendationShare: 5,
        top3Share: 0,
        providerMetrics: {
          openai: { mentionShare: 0, recommendationShare: 0, top3Share: 0, tests: 2 },
          perplexity: { mentionShare: 0, recommendationShare: 0, top3Share: 0, tests: 2 },
          gemini: { mentionShare: 0, recommendationShare: 0, top3Share: 0, tests: 2 },
        },
        foundScore: null,
        foundStatus: "not_evaluated",
        understoodScore: 40,
        understoodStatus: "ok",
        recommendedScore: 10,
        recommendedStatus: "ok",
        boughtScore: null,
        boughtStatus: "not_evaluated",
        overallScore: 25,
        overallStatus: "ok",
        intelligenceSummary: {
          overall: { score: 25 },
          competitorGap: { targetShare: 5, competitorShare: 60, gap: -55, competitorName: "Kind" },
          perception: {
            brandThemes: ["organic"],
            aiThemes: ["protein"],
            missingThemes: ["organic"],
            unexpectedThemes: ["protein"],
            method: "deterministic_keywords",
          },
        },
        questions: [
          { sortOrder: 0, question: { id: "q1", question: "best organic snacks", category: "discovery" } },
        ],
        aiTests: [
          { id: "t1", provider: "openai", model: "mock", question: "q", brandMentioned: false, error: null, answer: "SECRET_RAW_ANSWER" },
          { id: "t2", provider: "openai", model: "mock", question: "q2", brandMentioned: false, error: null, answer: "SECRET_RAW_ANSWER" },
          { id: "t3", provider: "perplexity", model: "mock", question: "q", brandMentioned: false, error: null, answer: "SECRET_RAW_ANSWER" },
          { id: "t4", provider: "gemini", model: "mock", question: "q", brandMentioned: false, error: null, answer: "SECRET_RAW_ANSWER" },
        ],
        competitors: [{ name: "Kind", mentions: 5, recommendationShare: 60, top3Share: 50 }],
        perception: {
          brandThemes: ["organic"],
          aiThemes: ["protein"],
          missingThemes: ["organic"],
          unexpectedThemes: ["protein"],
          method: "deterministic_keywords",
        },
        ...partial,
      };
      state.audits.push(row);
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
    },
    usagePeriod: {
      async upsert({ where, create }) {
        let row = state.usagePeriods.find(
          (p) =>
            p.workspaceId === where.workspaceId_periodStart.workspaceId &&
            p.periodStart.getTime() === where.workspaceId_periodStart.periodStart.getTime()
        );
        if (!row) {
          row = { id: genId(), ...create, aiTests: 0, aiTestsReserved: 0, audits: 0, monitoringRuns: 0 };
          state.usagePeriods.push(row);
        }
        return { ...row };
      },
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
      async findFirst({ where }) {
        return (
          state.apiKeys.find((k) => {
            if (where.id && k.id !== where.id) return false;
            if (where.workspaceId && k.workspaceId !== where.workspaceId) return false;
            return true;
          }) || null
        );
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
      async findMany({ where }) {
        return state.apiKeys.filter((k) => !where?.workspaceId || k.workspaceId === where.workspaceId);
      },
    },
    audit: {
      async findMany({ where, orderBy, take, include }) {
        const clerkUserId = where?.website?.workspace?.clerkUserId;
        const websiteId = where?.website?.id;
        let rows = state.audits.filter((a) => {
          const site = state.websites.find((w) => w.id === a.websiteId) || a.website;
          const ws = state.workspaces.find((w) => w.id === site.workspaceId);
          if (clerkUserId && ws?.clerkUserId !== clerkUserId) return false;
          if (websiteId && a.websiteId !== websiteId) return false;
          return true;
        });
        if (orderBy?.completedAt === "desc") {
          rows = [...rows].sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
        }
        if (take) rows = rows.slice(0, take);
        return rows.map((a) => {
          const site = state.websites.find((w) => w.id === a.websiteId) || a.website;
          const out = { ...a, website: site };
          if (include?.competitors) {
            out.competitors = (a.competitors || []).slice(0, include.competitors.take || 5);
          }
          return out;
        });
      },
      async findFirst({ where, include }) {
        const clerkUserId = where?.website?.workspace?.clerkUserId;
        const row = state.audits.find((a) => {
          if (where.id && a.id !== where.id) return false;
          const site = state.websites.find((w) => w.id === a.websiteId) || a.website;
          const ws = state.workspaces.find((w) => w.id === site.workspaceId);
          if (clerkUserId && ws?.clerkUserId !== clerkUserId) return false;
          return true;
        });
        if (!row) return null;
        const site = state.websites.find((w) => w.id === row.websiteId) || row.website;
        const out = { ...row, website: site };
        if (include?.aiTests) out.aiTests = row.aiTests;
        if (include?.competitors) out.competitors = row.competitors;
        if (include?.perception) out.perception = row.perception;
        if (include?.questions) out.questions = row.questions;
        return out;
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

function mockScan() {
  return {
    clean: "example.com",
    total: 71,
    gap: 17,
    revenue: 24,
    findings: [
      { key: "discover", t: "Found", score: 80, ok: true, note: "crawlers allowed" },
      { key: "understand", t: "Understood", score: 70, ok: true, note: "schema present" },
      { key: "recommend", t: "Recommended", score: 60, ok: false, note: "no ratings" },
      { key: "transact", t: "Bought", score: 74, ok: true, note: "shopify" },
    ],
    verdict: "An AI agent found example.com but hesitated - some products were unclear and checkout was uncertain.",
    isShopify: true,
  };
}

function parseTool(result) {
  const text = result.content?.[0]?.text;
  return { isError: result.isError === true, body: JSON.parse(text) };
}

async function mcpCall(name, args, { token, db, scanStore, scanLimit }) {
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
  return handleMcpHttp(req, {
    db,
    enabled: true,
    siteUrl: SITE,
    scanStore,
    scanLimit,
  });
}

async function readJson(res) {
  return JSON.parse(await res.text());
}

describe("scan_store", () => {
  it("rejects invalid and private URLs without scanning", async () => {
    const db = createFakeDb();
    const ws = db.addWorkspace();
    let scanned = 0;
    const ctx = {
      db,
      workspace: ws,
      entitlements: freeEnt,
      scanLimit: 30,
      scanStore: async () => {
        scanned += 1;
        return mockScan();
      },
    };
    for (const url of ["http://localhost", "http://127.0.0.1", "http://192.168.1.9", "ftp://example.com", ""]) {
      const out = parseTool(await runScanStoreTool(ctx, { url }));
      assert.equal(out.isError, true);
      assert.equal(out.body.code, "INVALID_URL");
    }
    assert.equal(scanned, 0);
  });

  it("returns a compact summary and does not consume AI tests", async () => {
    const db = createFakeDb();
    const ws = db.addWorkspace();
    const beforeUsage = db.state.usagePeriods.length;
    const out = parseTool(
      await runScanStoreTool(
        { db, workspace: ws, entitlements: freeEnt, scanStore: async () => mockScan() },
        { url: "https://example.com" }
      )
    );
    assert.equal(out.isError, false);
    assert.equal(out.body.domain, "example.com");
    assert.equal(out.body.score, 71);
    assert.equal(out.body.isShopify, true);
    assert.equal(out.body.pillars.length, 4);
    assert.equal(out.body.revenue, undefined);
    assert.equal(db.state.usagePeriods.length, beforeUsage);
  });

  it("enforces a durable per-workspace scan rate limit", async () => {
    const db = createFakeDb();
    const ws = db.addWorkspace();
    const ctx = {
      db,
      workspace: ws,
      entitlements: freeEnt,
      scanLimit: 2,
      scanStore: async () => mockScan(),
    };
    assert.equal(parseTool(await runScanStoreTool(ctx, { url: "https://example.com" })).isError, false);
    assert.equal(parseTool(await runScanStoreTool(ctx, { url: "https://example.com" })).isError, false);
    const limited = parseTool(await runScanStoreTool(ctx, { url: "https://example.com" }));
    assert.equal(limited.isError, true);
    assert.equal(limited.body.code, "RATE_LIMIT");
    assert.equal(db.state.rateBuckets[0].count, 3);

    const other = db.addWorkspace();
    const otherOk = parseTool(
      await runScanStoreTool({ ...ctx, workspace: other }, { url: "https://example.com" })
    );
    assert.equal(otherOk.isError, false);
  });


  it("allows public scan_store without a Bearer key", async () => {
    const res = await mcpCall(
      SCAN_STORE_TOOL,
      { url: "https://example.com" },
      {
        scanStore: async () => mockScan(),
        scanLimit: 10,
      }
    );

    assert.equal(res.status, 200);
    const body = await readJson(res);
    assert.notEqual(body.result?.isError, true);

    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.domain, "example.com");
    assert.equal(payload.score, 71);
  });
});

describe("public scan_store rate limiting", () => {
  it("enforces the public scan_store rate limit", async () => {
    _resetRateLimitsForTests();

    const options = {
      scanStore: async () => mockScan(),
      scanLimit: 1,
    };

    const first = await mcpCall(
      SCAN_STORE_TOOL,
      { url: "https://example.com" },
      options
    );

    assert.equal(first.status, 200);
    const firstBody = await readJson(first);
    assert.notEqual(firstBody.result?.isError, true);

    const second = await mcpCall(
      SCAN_STORE_TOOL,
      { url: "https://example.com" },
      options
    );

    assert.equal(second.status, 200);
    const secondBody = await readJson(second);
    assert.equal(secondBody.result?.isError, true);

    const payload = JSON.parse(secondBody.result.content[0].text);
    assert.equal(payload.code, "RATE_LIMIT");
  });
});
describe("list_audits / get_audit / diagnose_audit", () => {
  async function setup(plan = "free") {
    const db = createFakeDb();
    const subscription = plan === "pro"
      ? { plan: PLAN_IDS.PRO, status: "active", provider: "paddle", providerSubscriptionId: "sub_verified_test", currentPeriodEnd: new Date(Date.now() + 86400_000) }
      : null;
    const ws = db.addWorkspace({ subscription });
    const site = db.addWebsite(ws, { domain: "acmefoods.com", brandName: "Acme Foods" });
    const audit = db.addAudit(site);
    const extra = [];
    for (let i = 0; i < 4; i += 1) {
      extra.push(db.addAudit(site, { id: `audit_extra_${i}`, completedAt: new Date(Date.UTC(2026, 7, 3 + i)) }));
    }
    const created = await createApiKey(db, {
      workspaceId: ws.id,
      entitlements: plan === "pro" ? proEnt : freeEnt,
      name: "mcp",
    });
    const ctx = {
      db,
      workspace: ws,
      entitlements: plan === "pro" ? proEnt : freeEnt,
    };
    return { db, ws, site, audit, extra, token: created.key, ctx };
  }

  it("lists only the authenticated workspace audits and caps Free history", async () => {
    const a = await setup("free");
    const other = a.db.addWorkspace({ clerkUserId: "other_user" });
    const otherSite = a.db.addWebsite(other, { domain: "other.example" });
    a.db.addAudit(otherSite, { id: "foreign_audit" });

    const listed = parseTool(await runListAuditsTool(a.ctx, { limit: 20 }));
    assert.equal(listed.isError, false);
    assert.equal(listed.body.entitlementLimit, 3);
    assert.equal(listed.body.audits.length, 3);
    assert.equal(listed.body.audits.some((x) => x.id === "foreign_audit"), false);
    assert.equal(listed.body.audits[0].domain, "acmefoods.com");
    assert.equal("providerMetrics" in listed.body.audits[0], false);
    assert.equal(JSON.stringify(listed.body).includes("SECRET_RAW_ANSWER"), false);
  });

  it("get_audit requires ownership and omits raw answers", async () => {
    const a = await setup("free");
    const ok = parseTool(await runGetAuditTool(a.ctx, { auditId: a.audit.id }));
    assert.equal(ok.isError, false);
    assert.equal(ok.body.id, a.audit.id);
    assert.equal(ok.body.website.domain, "acmefoods.com");
    assert.ok(ok.body.intelligenceSummary);
    assert.equal(JSON.stringify(ok.body).includes("SECRET_RAW_ANSWER"), false);
    for (const t of ok.body.aiTests) {
      assert.equal(Object.prototype.hasOwnProperty.call(t, "answer"), false);
      assert.equal(t.hasAnswer, true);
    }

    const missing = parseTool(await runGetAuditTool(a.ctx, {}));
    assert.equal(missing.isError, true);
    assert.equal(missing.body.code, "VALIDATION");

    const bWs = a.db.addWorkspace({ clerkUserId: "intruder" });
    const steal = parseTool(
      await runGetAuditTool({ db: a.db, workspace: bWs, entitlements: freeEnt }, { auditId: a.audit.id })
    );
    assert.equal(steal.isError, true);
    assert.equal(steal.body.code, "NOT_FOUND");
  });

  it("diagnose_audit previews 2 issues on Free and full set on Pro", async () => {
    const free = await setup("free");
    const freeOut = parseTool(await runDiagnoseAuditTool(free.ctx, { auditId: free.audit.id }));
    assert.equal(freeOut.isError, false);
    assert.equal(freeOut.body.limited, true);
    assert.ok(freeOut.body.issues.length <= 2);
    assert.equal(freeOut.body.upgrade.suggestedPlan, "pro");
    assert.equal(JSON.stringify(freeOut.body).includes("SECRET_RAW_ANSWER"), false);

    const pro = await setup("pro");
    const proOut = parseTool(await runDiagnoseAuditTool(pro.ctx, { auditId: pro.audit.id }));
    assert.equal(proOut.isError, false);
    assert.equal(proOut.body.limited, false);
    assert.ok(proOut.body.issues.length > 2);

    const steal = parseTool(
      await runDiagnoseAuditTool(
        { db: free.db, workspace: pro.ws, entitlements: proEnt },
        { auditId: free.audit.id }
      )
    );
    assert.equal(steal.isError, true);
    assert.equal(steal.body.code, "NOT_FOUND");
  });

  it("HTTP tools/call get_audit succeeds with a valid key", async () => {
    const a = await setup("free");
    const res = await mcpCall(GET_AUDIT_TOOL, { auditId: a.audit.id }, { token: a.token, db: a.db });
    assert.equal(res.status, 200);
    const body = await readJson(res);
    assert.notEqual(body.result?.isError, true);
    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.id, a.audit.id);
    assert.equal(JSON.stringify(payload).includes("SECRET_RAW_ANSWER"), false);
  });
});

describe("durable MCP rate limiter", () => {
  it("counts in hourly buckets", async () => {
    const db = createFakeDb();
    const ws = db.addWorkspace();
    const now = new Date("2026-08-18T10:15:00Z");
    const a = await consumeMcpRateLimit(db, { workspaceId: ws.id, action: "scan_store", limit: 2, now });
    const b = await consumeMcpRateLimit(db, { workspaceId: ws.id, action: "scan_store", limit: 2, now });
    const c = await consumeMcpRateLimit(db, { workspaceId: ws.id, action: "scan_store", limit: 2, now });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(c.ok, false);
    assert.equal(c.used, 3);
  });
});
