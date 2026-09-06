/**
 * MCP V1 Phase E — production smoke (fake DB / no live providers).
 * Walks the six MCP tools plus auth, entitlements, and shared usage with v2.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { runVisibilityAuditV2 } from "../../ai/visibility-v2.js";
import { currentBillingPeriod, getEntitlements, PLAN_IDS } from "../../billing/index.js";
import {
  DIAGNOSE_AUDIT_TOOL,
  GET_ACCOUNT_STATUS_TOOL,
  GET_AUDIT_TOOL,
  LIST_AUDITS_TOOL,
  MCP_RPC,
  MCP_V1_TOOL_NAMES,
  RUN_VISIBILITY_AUDIT_TOOL,
  SCAN_STORE_TOOL,
  createApiKey,
  handleMcpHttp,
  revokeApiKey,
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
      if (row.subscription) state.subscriptions.push({ ...row.subscription, workspaceId: row.id });
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
          row = { id: genId(), ...create };
          state.workspaces.push(row);
        } else if (update?.email) row.email = update.email;
        return row;
      },
    },
    website: {
      async findUnique({ where }) {
        if (where.workspaceId_domain) {
          const { workspaceId, domain } = where.workspaceId_domain;
          return state.websites.find((w) => w.workspaceId === workspaceId && w.domain === domain) || null;
        }
        return null;
      },
      async count({ where } = {}) {
        return state.websites.filter((w) => !where?.workspaceId || w.workspaceId === where.workspaceId).length;
      },
      async create({ data }) {
        const row = { id: genId(), ...data };
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
          row = { id: genId(), ...create };
          state.questions.push(row);
        } else Object.assign(row, update);
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
          row = { id: genId(), aiTests: 0, aiTestsReserved: 0, audits: 0, monitoringRuns: 0, ...create };
          state.usagePeriods.push(row);
        }
        return { ...row };
      },
      async findUnique({ where }) {
        return state.usagePeriods.find((p) => p.id === where.id) || null;
      },
      async update({ where, data }) {
        const row = state.usagePeriods.find((p) => p.id === where.id);
        if (data.aiTestsReserved?.increment) row.aiTestsReserved += data.aiTestsReserved.increment;
        return { ...row };
      },
    },
    async $executeRaw(strings, ...values) {
      const sql = Array.isArray(strings) ? strings.join(" ") : String(strings);
      if (sql.includes('"aiTests" =') && sql.includes("GREATEST")) {
        const [reserved, actual, audits, monitoring, id] = values;
        const row = state.usagePeriods.find((p) => p.id === id);
        row.aiTestsReserved = Math.max(0, row.aiTestsReserved - Number(reserved));
        row.aiTests += Number(actual);
        row.audits += Number(audits);
        row.monitoringRuns += Number(monitoring);
        return 1;
      }
      if (sql.includes("GREATEST")) {
        const [reserved, id] = values;
        const row = state.usagePeriods.find((p) => p.id === id);
        row.aiTestsReserved = Math.max(0, row.aiTestsReserved - Number(reserved));
        return 1;
      }
      const need = Number(values[0]) || 0;
      const id = values[1];
      const max = Number(values[values.length - 1]);
      const row = state.usagePeriods.find((p) => p.id === id);
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
          row = { id: genId(), count: 0, ...create };
          state.rateBuckets.push(row);
          return { ...row };
        }
        if (update?.count?.increment) row.count += update.count.increment;
        return { ...row };
      },
    },
    apiKey: {
      async create({ data }) {
        const row = { id: genId(), status: "active", lastUsedAt: null, revokedAt: null, expiresAt: null, createdAt: new Date(), ...data };
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
        const row = where.keyHash
          ? state.apiKeys.find((k) => k.keyHash === where.keyHash)
          : state.apiKeys.find((k) => k.id === where.id);
        if (!row) return null;
        if (include?.workspace) return { ...row, workspace: state.workspaces.find((w) => w.id === row.workspaceId) };
        return { ...row };
      },
      async update({ where, data }) {
        const row = state.apiKeys.find((k) => k.id === where.id);
        Object.assign(row, data);
        return { ...row };
      },
      async count({ where }) {
        return state.apiKeys.filter((k) => k.workspaceId === where.workspaceId && (!where.status || k.status === where.status)).length;
      },
    },
    audit: {
      async create({ data, include }) {
        const { questions, aiTests, competitors, perception, ...auditData } = data;
        const audit = { id: genId(), ...auditData };
        state.audits.push(audit);
        const tests = [];
        for (const t of aiTests?.create || []) {
          const row = { id: genId(), auditId: audit.id, ...t };
          state.aiTests.push(row);
          tests.push(row);
        }
        const comps = [];
        for (const c of competitors?.create || []) {
          const row = { id: genId(), auditId: audit.id, ...c };
          state.competitors.push(row);
          comps.push(row);
        }
        const linked = [];
        for (const q of questions?.create || []) {
          const question = state.questions.find((x) => x.id === q.questionId);
          linked.push({ ...q, auditId: audit.id, question });
        }
        let perc = null;
        if (perception?.create) {
          perc = { id: genId(), auditId: audit.id, ...perception.create };
          state.perceptions.push(perc);
        }
        if (!include) return audit;
        return { ...audit, aiTests: tests, competitors: comps, questions: linked, perception: perc };
      },
      async findMany({ where, orderBy, take, include }) {
        const clerkUserId = where?.website?.workspace?.clerkUserId;
        let rows = state.audits.filter((a) => {
          const site = state.websites.find((w) => w.id === a.websiteId);
          const ws = state.workspaces.find((w) => w.id === site?.workspaceId);
          return !clerkUserId || ws?.clerkUserId === clerkUserId;
        });
        if (orderBy?.completedAt === "desc") {
          rows = [...rows].sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
        }
        if (take) rows = rows.slice(0, take);
        return rows.map((a) => ({
          ...a,
          website: state.websites.find((w) => w.id === a.websiteId),
          competitors: include?.competitors ? state.competitors.filter((c) => c.auditId === a.id).slice(0, 5) : undefined,
        }));
      },
      async findFirst({ where, include }) {
        const rows = state.audits.filter((a) => {
          if (where?.id && typeof where.id === "string" && a.id !== where.id) return false;
          if (where?.id?.not && a.id === where.id.not) return false;
          if (where?.websiteId && a.websiteId !== where.websiteId) return false;
          if (where?.status && a.status !== where.status) return false;
          const site = state.websites.find((w) => w.id === a.websiteId);
          const ws = state.workspaces.find((w) => w.id === site?.workspaceId);
          if (where?.website?.workspace?.clerkUserId && ws?.clerkUserId !== where.website.workspace.clerkUserId) return false;
          return true;
        });
        const audit = rows[0];
        if (!audit) return null;
        const site = state.websites.find((w) => w.id === audit.websiteId);
        return {
          ...audit,
          website: site,
          aiTests: include?.aiTests ? state.aiTests.filter((t) => t.auditId === audit.id) : undefined,
          competitors: include?.competitors ? state.competitors.filter((c) => c.auditId === audit.id) : undefined,
          perception: include?.perception ? state.perceptions.find((p) => p.auditId === audit.id) || null : undefined,
          questions: include?.questions
            ? state.questions.filter((q) => q.websiteId === audit.websiteId).map((q) => ({ question: q }))
            : undefined,
        };
      },
    },
  };
  return db;
}

function rpc(method, params, id = 1) {
  return { jsonrpc: "2.0", id, method, params: params || {} };
}

async function mcpPost(body, { token, db, enabled = true, visibilityAudit, scanStore } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const req = new Request(`${SITE}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  return handleMcpHttp(req, { db, enabled, siteUrl: SITE, visibilityAudit, scanStore });
}

async function readJson(res) {
  return JSON.parse(await res.text());
}

function toolPayload(body) {
  assert.notEqual(body.result?.isError, true);
  const text = body.result?.content?.[0]?.text;
  const parsed = JSON.parse(text);
  assert.equal(JSON.stringify(parsed).includes(SECRET), false);
  return parsed;
}

function mockScan() {
  return {
    clean: "example.com",
    total: 71,
    gap: 17,
    verdict: "ok",
    isShopify: true,
    findings: [{ key: "discover", t: "Found", score: 80, ok: true, note: "ok" }],
  };
}

function mockProviders() {
  return async ({ buyerQuestion }) =>
    ["openai", "perplexity", "gemini"].map((provider) => ({
      provider,
      model: "mock",
      question: buyerQuestion,
      answer: SECRET,
      brandMentioned: true,
      brandPosition: 2,
      recommended: false,
      competitors: [{ name: "Kind", position: 1 }],
      citations: [],
      confidence: 0.8,
      latencyMs: 1,
      error: null,
    }));
}

const visibilityAudit = {
  siteSignals: async () => ({ ok: true, title: "Acme", desc: "", h1: "", ogTitle: "", bodyText: "snacks" }),
  runAllProviders: mockProviders(),
};

describe("MCP production smoke", () => {
  it("covers flag, auth, six tools, entitlements, and shared usage", async () => {
    const db = createFakeDb();
    const ws = db.addWorkspace();
    const entitlements = getEntitlements(null);
    const created = await createApiKey(db, { workspaceId: ws.id, entitlements, name: "smoke" });
    const token = created.key;

    const disabled = await mcpPost(rpc("ping"), { db, token, enabled: false });
    assert.equal(disabled.status, 404);

    const missing = await mcpPost(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "s", version: "1" } }), { db, enabled: true });
    assert.equal(missing.status, 401);
    assert.equal((await readJson(missing)).error.code, MCP_RPC.UNAUTHORIZED);

    const invalid = await mcpPost(rpc("ping"), { db, enabled: true, token: "aso_test_thiskeydoesnotexist01" });
    assert.equal(invalid.status, 401);

    const revokedKey = await createApiKey(db, { workspaceId: ws.id, entitlements, name: "rev" });
    await revokeApiKey(db, { workspaceId: ws.id, keyId: revokedKey.apiKey.id });
    assert.equal((await mcpPost(rpc("ping"), { db, enabled: true, token: revokedKey.key })).status, 401);

    const exp = await createApiKey(db, { workspaceId: ws.id, entitlements, name: "exp", expiresAt: new Date(Date.now() + 60_000) });
    db.state.apiKeys.find((k) => k.id === exp.apiKey.id).expiresAt = new Date(Date.now() - 1000);
    assert.equal((await mcpPost(rpc("ping"), { db, enabled: true, token: exp.key })).status, 401);

    const init = await mcpPost(
      rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "1" } }),
      { db, enabled: true, token }
    );
    assert.equal(init.status, 200);
    assert.equal((await readJson(init)).result.serverInfo.name, "agenticaso");

    const listed = await readJson(await mcpPost(rpc("tools/list"), { db, enabled: true, token }));
    assert.deepEqual(
      (listed.result.tools || []).map((t) => t.name),
      MCP_V1_TOOL_NAMES
    );

    const status = toolPayload(
      await readJson(await mcpPost(rpc("tools/call", { name: GET_ACCOUNT_STATUS_TOOL, arguments: {} }), { db, enabled: true, token }))
    );
    assert.equal(status.plan, PLAN_IDS.FREE);
    assert.equal(typeof status.remaining.aiTests, "number");
    assert.match(status.upgradeUrl, /utm_source=mcp/);
    assert.match(status.upgradeUrl, /utm_campaign=get_account_status/);

    const scan = toolPayload(
      await readJson(
        await mcpPost(rpc("tools/call", { name: SCAN_STORE_TOOL, arguments: { url: "https://example.com" } }), {
          db,
          enabled: true,
          token,
          scanStore: async () => mockScan(),
        })
      )
    );
    assert.equal(scan.domain, "example.com");

    const auditHttp = await mcpPost(
      rpc("tools/call", {
        name: RUN_VISIBILITY_AUDIT_TOOL,
        arguments: { url: "https://acmefoods.com", brand: "Acme Foods", question: "best organic snacks" },
      }),
      { db, enabled: true, token, visibilityAudit }
    );
    assert.equal(auditHttp.status, 200);
    const audit = toolPayload(await readJson(auditHttp));
    assert.ok(audit.auditId);
    assert.equal(audit.usage.aiTestsCharged, 3);
    const usageAfterMcp = db.state.usagePeriods.find((p) => p.workspaceId === ws.id);
    assert.equal(usageAfterMcp.aiTests, 3);
    assert.equal(usageAfterMcp.aiTestsReserved, 0);

    const listedAudits = toolPayload(
      await readJson(await mcpPost(rpc("tools/call", { name: LIST_AUDITS_TOOL, arguments: {} }), { db, enabled: true, token }))
    );
    assert.equal(listedAudits.audits.some((a) => a.id === audit.auditId), true);

    const got = toolPayload(
      await readJson(
        await mcpPost(rpc("tools/call", { name: GET_AUDIT_TOOL, arguments: { auditId: audit.auditId } }), { db, enabled: true, token })
      )
    );
    assert.equal(got.id, audit.auditId);
    assert.equal(got.aiTests.every((t) => !Object.prototype.hasOwnProperty.call(t, "answer")), true);

    const diagnosis = toolPayload(
      await readJson(
        await mcpPost(rpc("tools/call", { name: DIAGNOSE_AUDIT_TOOL, arguments: { auditId: audit.auditId } }), {
          db,
          enabled: true,
          token,
        })
      )
    );
    assert.equal(diagnosis.limited, true);
    assert.equal(diagnosis.upgrade.upgrade, true);
    assert.equal(diagnosis.upgrade.code, "ENTITLEMENT_REQUIRED");
    assert.match(diagnosis.upgrade.upgradeUrl, /utm_campaign=diagnose_audit/);
    assert.equal(diagnosis.upgrade.plan, PLAN_IDS.FREE);

    db.addWebsite(ws, { domain: "already-used.com" });
    const slot = await readJson(
      await mcpPost(
        rpc("tools/call", {
          name: RUN_VISIBILITY_AUDIT_TOOL,
          arguments: { url: "https://newstore.example.com", brand: "New", question: "best snacks", plan: "pro" },
        }),
        { db, enabled: true, token, visibilityAudit }
      )
    );
    const slotBody = JSON.parse(slot.result.content[0].text);
    assert.equal(slot.result.isError, true);
    assert.equal(slotBody.upgrade, true);
    assert.equal(slotBody.code, "ENTITLEMENT_REQUIRED");
    assert.equal(slotBody.feature, "websites");
    assert.match(slotBody.upgradeUrl, /utm_source=mcp/);

    const other = db.addWorkspace({ clerkUserId: "intruder" });
    const otherKey = await createApiKey(db, { workspaceId: other.id, entitlements, name: "other" });
    const steal = await readJson(
      await mcpPost(rpc("tools/call", { name: GET_AUDIT_TOOL, arguments: { auditId: audit.auditId } }), {
        db,
        enabled: true,
        token: otherKey.key,
      })
    );
    assert.equal(JSON.parse(steal.result.content[0].text).code, "NOT_FOUND");

    const { periodStart, periodEnd } = currentBillingPeriod();
    const restWs = db.addWorkspace({ clerkUserId: "rest_user" });
    db.state.usagePeriods.push({
      id: genId(),
      workspaceId: restWs.id,
      periodStart,
      periodEnd,
      aiTests: 0,
      aiTestsReserved: 0,
      audits: 0,
      monitoringRuns: 0,
    });
    const rest = await runVisibilityAuditV2(
      {
        url: "https://reststore.example.com",
        brand: "Rest Store",
        question: "best snacks",
        entitlements,
        workspace: restWs,
        prisma: db,
        clerkUserId: restWs.clerkUserId,
      },
      visibilityAudit
    );
    assert.equal(rest.ok, true);
    const restUsage = db.state.usagePeriods.find((p) => p.workspaceId === restWs.id);
    assert.equal(restUsage.aiTests, 3);
    assert.equal(restUsage.aiTestsReserved, 0);
    assert.equal(rest.payload.usage.aiTestsCharged, 3);
  });
});
