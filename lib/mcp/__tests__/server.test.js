/**
 * MCP V1 Phase B - stateless Streamable HTTP server.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { getEntitlements, PLAN_IDS } from "../../billing/index.js";
import { _resetRateLimitsForTests } from "../rate-limit.js";
import {
  GET_ACCOUNT_STATUS_TOOL,
  MCP_RPC,
  createApiKey,
  handleMcpHttp,
  revokeApiKey,
} from "../index.js";

const PREV_PEPPER = process.env.MCP_KEY_PEPPER;
const PREV_ENABLED = process.env.MCP_ENABLED;
const PREV_SITE = process.env.NEXT_PUBLIC_SITE_URL;
const TEST_PEPPER = "unit-test-mcp-pepper-not-for-production";
const SITE = "https://mcp.test.agenticaso.com";

before(() => {
  process.env.MCP_KEY_PEPPER = TEST_PEPPER;
  process.env.MCP_ENABLED = "true";
  process.env.NEXT_PUBLIC_SITE_URL = SITE;
});

after(() => {
  if (PREV_PEPPER == null) delete process.env.MCP_KEY_PEPPER;
  else process.env.MCP_KEY_PEPPER = PREV_PEPPER;
  if (PREV_ENABLED == null) delete process.env.MCP_ENABLED;
  else process.env.MCP_ENABLED = PREV_ENABLED;
  if (PREV_SITE == null) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = PREV_SITE;
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
    rateBuckets: [],
  };

  return {
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
    workspace: {
      async findUnique({ where, include }) {
        const row = state.workspaces.find((w) => {
          if (where?.id) {
            return w.id === where.id;
          }

          if (where?.clerkUserId) {
            return w.clerkUserId === where.clerkUserId;
          }

          return false;
        });

        if (!row) return null;

        const out = { ...row };

        if (include?.subscription) {
          out.subscription =
            state.subscriptions.find(
              (s) => s.workspaceId === row.id
            ) || null;
        }

        if (include?._count) {
          out._count = {
            websites: state.websites.filter(
              (w) => w.workspaceId === row.id
            ).length,
          };
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
          row = {
            id: genId(),
            ...create,
            aiTests: 12,
            aiTestsReserved: 0,
            audits: 1,
            monitoringRuns: 0,
          };
          state.usagePeriods.push(row);
        }
        return { ...row };
      },
    },
    monitoring: {
      async count() {
        return 0;
      },
    },
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
  };
}

const freeEntitlements = getEntitlements(null);

function rpc(method, params, id = 1) {
  return { jsonrpc: "2.0", id, method, params: params || {} };
}

async function mcpPost(
  body,
  {
    token,
    db,
    enabled,
    now,
    siteUrl,
    authenticateOAuthRequest,
  } = {}
) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };

  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const req = new Request("https://mcp.test.agenticaso.com/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  return handleMcpHttp(req, {
    db,
    enabled,
    now,
    siteUrl: siteUrl || SITE,
    authenticateOAuthRequest,
  });
}

async function readJson(res) {
  const text = await res.text();

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
describe("MCP HTTP feature flag and CORS", () => {
  it("returns 404 when MCP is disabled", async () => {
    const db = createFakeDb();
    const res = await mcpPost(rpc("ping"), { db, enabled: false, token: "aso_test_xxxxxxxxxxxxxxxx" });
    assert.equal(res.status, 404);
    const body = await readJson(res);
    assert.equal(body.error, "Not found.");
  });

  it("answers OPTIONS with CORS when enabled", async () => {
    const req = new Request("https://mcp.test.agenticaso.com/mcp", { method: "OPTIONS" });
    const res = await handleMcpHttp(req, { enabled: true, db: createFakeDb() });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(res.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
  });
});

describe("MCP Bearer authentication", () => {

  it("allows public initialize without a key", async () => {
    const res = await mcpPost(
      rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "public-test", version: "1" },
      }),
      { enabled: true }
    );

    assert.equal(res.status, 200);
    const body = await readJson(res);
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.result?.serverInfo?.name, "agenticaso");
    assert.ok(body.result?.protocolVersion);
  });

  it("rejects an invalid key", async () => {
    const db = createFakeDb();
    db.addWorkspace();
    const res = await mcpPost(rpc("ping"), {
      db,
      enabled: true,
      token: "aso_test_thiskeydoesnotexist01",
    });
    assert.equal(res.status, 401);
    const body = await readJson(res);
    assert.equal(body.error.code, MCP_RPC.UNAUTHORIZED);
  });

  it("rejects a revoked key", async () => {
    const db = createFakeDb();
    const ws = db.addWorkspace();
    const created = await createApiKey(db, { workspaceId: ws.id, entitlements: freeEntitlements, name: "rev" });
    await revokeApiKey(db, { workspaceId: ws.id, keyId: created.apiKey.id });
    const res = await mcpPost(rpc("ping"), { db, enabled: true, token: created.key });
    assert.equal(res.status, 401);
  });

  it("rejects an expired key", async () => {
    const db = createFakeDb();
    const ws = db.addWorkspace();
    const created = await createApiKey(db, {
      workspaceId: ws.id,
      entitlements: freeEntitlements,
      expiresAt: new Date(Date.now() + 60_000),
    });
    db.state.apiKeys[0].expiresAt = new Date(Date.now() - 1000);
    const res = await mcpPost(rpc("ping"), { db, enabled: true, token: created.key });
    assert.equal(res.status, 401);
  });
});

describe("MCP public access security", () => {
  it("public tools/list exposes only scan_store", async () => {
    _resetRateLimitsForTests();

    const res = await mcpPost(rpc("tools/list"), {
      enabled: true,
    });

    assert.equal(res.status, 200);
    const body = await readJson(res);
    const names = (body.result?.tools || []).map((tool) => tool.name);

    assert.deepEqual(names, ["scan_store"]);
  });

  it("public access cannot call private account tools", async () => {
    _resetRateLimitsForTests();

    const res = await mcpPost(
      rpc("tools/call", {
        name: GET_ACCOUNT_STATUS_TOOL,
        arguments: {},
      }),
      { enabled: true }
    );

    assert.equal(res.status, 200);
    const body = await readJson(res);

    assert.ok(body.error || body.result?.isError === true);
    assert.equal(JSON.stringify(body).includes('"plan"'), false);
  });

  it("malformed Authorization never downgrades to public access", async () => {
    _resetRateLimitsForTests();

    const req = new Request("https://mcp.test.agenticaso.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Basic nope",
      },
      body: JSON.stringify(rpc("tools/list")),
    });

    const res = await handleMcpHttp(req, { enabled: true });

    assert.equal(res.status, 401);
    const body = await readJson(res);
    assert.equal(body.error.code, MCP_RPC.UNAUTHORIZED);
  });

  it("enforces the anonymous public HTTP rate limit", async () => {
    _resetRateLimitsForTests();

    const makeRequest = () =>
      new Request("https://mcp.test.agenticaso.com/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-vercel-forwarded-for": "203.0.113.77",
        },
        body: JSON.stringify(rpc("tools/list")),
      });

    const first = await handleMcpHttp(makeRequest(), {
      enabled: true,
      publicHttpLimit: 1,
      publicClientId: "public-http-test",
    });

    assert.equal(first.status, 200);

    const second = await handleMcpHttp(makeRequest(), {
      enabled: true,
      publicHttpLimit: 1,
      publicClientId: "public-http-test",
    });

    assert.equal(second.status, 429);
  });
});
describe("MCP Clerk OAuth authentication", () => {
  it("valid OAuth identity maps to its workspace and exposes private tools", async () => {
    const db = createFakeDb();
    const ws = db.addWorkspace({
      clerkUserId: "user_oauth_valid",
    });

    const authenticateOAuthRequest = async () => ({
      userId: "user_oauth_valid",
      scopes: ["openid", "profile", "email"],
    });

    const res = await mcpPost(rpc("tools/list"), {
      db,
      enabled: true,
      token: "oauth_test_valid_token",
      authenticateOAuthRequest,
    });

    assert.equal(res.status, 200);

    const body = await readJson(res);
    const names = (body.result?.tools || []).map((tool) => tool.name);

    assert.ok(names.includes(GET_ACCOUNT_STATUS_TOOL));
    assert.ok(names.includes("scan_store"));
    assert.ok(names.includes("list_audits"));
    assert.ok(names.includes("get_audit"));
    assert.ok(names.includes("diagnose_audit"));
    assert.ok(names.includes("run_visibility_audit"));

    assert.equal(db.state.workspaces.length, 1);
    assert.equal(ws.clerkUserId, "user_oauth_valid");
  });

  it("invalid OAuth credential returns 401 and never falls back to public mode", async () => {
    const db = createFakeDb();

    const authenticateOAuthRequest = async () => null;

    const res = await mcpPost(rpc("tools/list"), {
      db,
      enabled: true,
      token: "oauth_test_invalid_token",
      authenticateOAuthRequest,
    });

    assert.equal(res.status, 401);

    const body = await readJson(res);
    assert.equal(body.error.code, MCP_RPC.UNAUTHORIZED);
  });

  it("valid OAuth user without an Agenticaso workspace returns 401", async () => {
    const db = createFakeDb();

    const authenticateOAuthRequest = async () => ({
      userId: "user_without_workspace",
      scopes: ["openid"],
    });

    const res = await mcpPost(rpc("tools/list"), {
      db,
      enabled: true,
      token: "oauth_test_no_workspace",
      authenticateOAuthRequest,
    });

    assert.equal(res.status, 401);

    const body = await readJson(res);
    assert.equal(body.error.code, MCP_RPC.UNAUTHORIZED);
  });

  it("OAuth authentication does not require MCP_KEY_PEPPER", async () => {
    const db = createFakeDb();
    db.addWorkspace({
      clerkUserId: "user_oauth_no_pepper",
    });

    const previousPepper = process.env.MCP_KEY_PEPPER;
    delete process.env.MCP_KEY_PEPPER;

    try {
      const authenticateOAuthRequest = async () => ({
        userId: "user_oauth_no_pepper",
        scopes: ["openid"],
      });

      const res = await mcpPost(rpc("tools/list"), {
        db,
        enabled: true,
        token: "oauth_test_no_pepper",
        authenticateOAuthRequest,
      });

      assert.equal(res.status, 200);

      const body = await readJson(res);
      const names = (body.result?.tools || []).map((tool) => tool.name);

      assert.ok(names.includes(GET_ACCOUNT_STATUS_TOOL));
    } finally {
      if (previousPepper == null) {
        delete process.env.MCP_KEY_PEPPER;
      } else {
        process.env.MCP_KEY_PEPPER = previousPepper;
      }
    }
  });
});
describe("MCP protocol", () => {
  async function withKey(plan = "free") {
    const db = createFakeDb();
    const subscription = plan === "pro"
      ? { plan: PLAN_IDS.PRO, status: "active", provider: "paddle", providerSubscriptionId: "sub_verified_test", currentPeriodEnd: new Date(Date.now() + 86400_000) }
      : null;
    const ws = db.addWorkspace({ subscription });
    const created = await createApiKey(db, {
      workspaceId: ws.id,
      entitlements: getEntitlements(subscription),
      name: "mcp",
    });
    return { db, token: created.key, ws };
  }

  it("handles initialize", async () => {
    const { db, token } = await withKey();
    const res = await mcpPost(
      rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "phase-b-test", version: "1.0.0" },
      }),
      { db, enabled: true, token }
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type")?.includes("application/json"), true);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    const body = await readJson(res);
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.result.serverInfo.name, "agenticaso");
    assert.ok(body.result.protocolVersion);
    assert.equal(body.result.capabilities.tools !== undefined, true);
  });

  it("handles tools/list with Phase D run_visibility_audit and not deferred tools", async () => {
    const { db, token } = await withKey();
    const res = await mcpPost(rpc("tools/list"), { db, enabled: true, token });
    assert.equal(res.status, 200);
    const body = await readJson(res);
    const names = (body.result?.tools || []).map((t) => t.name);
    assert.deepEqual(names, [
      GET_ACCOUNT_STATUS_TOOL,
      "scan_store",
      "list_audits",
      "get_audit",
      "diagnose_audit",
      "run_visibility_audit",
    ]);
    assert.equal(names.includes("generate_fix"), false);
    assert.equal(names.includes("compare_audits"), false);
    assert.equal(names.includes("export_audit"), false);
  });

  it("handles ping", async () => {
    const { db, token } = await withKey();
    const res = await mcpPost(rpc("ping"), { db, enabled: true, token });
    assert.equal(res.status, 200);
    const body = await readJson(res);
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.id, 1);
    assert.ok(body.result && typeof body.result === "object");
  });

  it("returns compact get_account_status with plan, paid, remaining, and URLs", async () => {
    const { db, token } = await withKey("free");
    const res = await mcpPost(rpc("tools/call", { name: GET_ACCOUNT_STATUS_TOOL, arguments: {} }), {
      db,
      enabled: true,
      token,
    });
    assert.equal(res.status, 200);
    const body = await readJson(res);
    assert.notEqual(body.result?.isError, true);
    const text = body.result?.content?.[0]?.text;
    assert.equal(typeof text, "string");
    const payload = JSON.parse(text);
    assert.equal(payload.plan, PLAN_IDS.FREE);
    assert.equal(payload.isPaid, false);
    assert.equal(payload.dashboardUrl, `${SITE}/dashboard`);
    assert.equal(
      payload.upgradeUrl,
      `${SITE}/billing?utm_source=mcp&utm_medium=mcp_tool&utm_campaign=get_account_status`
    );
    assert.equal(typeof payload.remaining.aiTests, "number");
    assert.equal(typeof payload.remaining.websites, "number");
    assert.ok("monitoring" in payload.remaining);
    assert.equal(payload.usage.aiTests.used, 12);
  });

  it("GET is 405 JSON-RPC without SSE", async () => {
    const req = new Request("https://mcp.test.agenticaso.com/mcp", {
      method: "GET",
      headers: { accept: "application/json, text/event-stream" },
    });
    const res = await handleMcpHttp(req, { enabled: true, db: createFakeDb() });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("Allow"), "POST, OPTIONS");
    const body = await readJson(res);
    assert.equal(body.error.code, MCP_RPC.SERVER);
  });
});
