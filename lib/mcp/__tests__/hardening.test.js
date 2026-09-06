/**
 * MCP V1 Phase E — production hardening (no new tools).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sanitizeErrorMessage } from "../../api/safe-error.js";
import { validateStoreUrl } from "../../ai/audit.js";
import { getEntitlements } from "../../billing/index.js";
import {
  MCP_AUDIT_ACTION,
  MCP_HTTP_ACTION,
  MCP_MAX_REQUEST_BYTES,
  MCP_SCAN_STORE_ACTION,
  consumeMcpRateLimit,
  createApiKey,
  handleMcpHttp,
  isMcpProtocolPath,
} from "../index.js";
import { MCP_MAX_TOOL_JSON_CHARS, mcpToolJson } from "../tools/result.js";

const PREV_PEPPER = process.env.MCP_KEY_PEPPER;
const TEST_PEPPER = "unit-test-mcp-pepper-not-for-production";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

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
  const state = { workspaces: [], apiKeys: [], rateBuckets: [] };
  return {
    state,
    addWorkspace(partial = {}) {
      const row = {
        id: partial.id || genId(),
        clerkUserId: partial.clerkUserId || `user_${genId()}`,
        email: null,
        subscription: null,
      };
      state.workspaces.push(row);
      return row;
    },
    workspace: {
      async findUnique({ where, include }) {
        const row = state.workspaces.find((w) => w.id === where.id);
        if (!row) return null;
        const out = { ...row };
        if (include?.subscription) out.subscription = null;
        if (include?._count) out._count = { websites: 0 };
        return out;
      },
    },
    usagePeriod: {
      async upsert({ create, where }) {
        return {
          id: genId(),
          aiTests: 0,
          aiTestsReserved: 0,
          audits: 0,
          monitoringRuns: 0,
          ...create,
          workspaceId: where?.workspaceId_periodStart?.workspaceId,
        };
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
      async findUnique({ where, include }) {
        const row = where.keyHash
          ? state.apiKeys.find((k) => k.keyHash === where.keyHash)
          : state.apiKeys.find((k) => k.id === where.id);
        if (!row) return null;
        if (include?.workspace) {
          return { ...row, workspace: state.workspaces.find((w) => w.id === row.workspaceId) || null };
        }
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
  };
}

describe("durable MCP rate-limit buckets are separate", () => {
  it("tracks http, scan_store, and run_visibility_audit independently", async () => {
    const db = createFakeDb();
    const ws = db.addWorkspace();
    const now = new Date("2026-08-18T10:00:00Z");
    const http1 = await consumeMcpRateLimit(db, { workspaceId: ws.id, action: MCP_HTTP_ACTION, limit: 2, now });
    const scan1 = await consumeMcpRateLimit(db, { workspaceId: ws.id, action: MCP_SCAN_STORE_ACTION, limit: 1, now });
    const audit1 = await consumeMcpRateLimit(db, { workspaceId: ws.id, action: MCP_AUDIT_ACTION, limit: 1, now });
    assert.equal(http1.ok, true);
    assert.equal(scan1.ok, true);
    assert.equal(audit1.ok, true);

    const scan2 = await consumeMcpRateLimit(db, { workspaceId: ws.id, action: MCP_SCAN_STORE_ACTION, limit: 1, now });
    assert.equal(scan2.ok, false);
    const auditStill = await consumeMcpRateLimit(db, { workspaceId: ws.id, action: MCP_AUDIT_ACTION, limit: 1, now });
    assert.equal(auditStill.ok, false);
    const http2 = await consumeMcpRateLimit(db, { workspaceId: ws.id, action: MCP_HTTP_ACTION, limit: 2, now });
    assert.equal(http2.ok, true);
    const http3 = await consumeMcpRateLimit(db, { workspaceId: ws.id, action: MCP_HTTP_ACTION, limit: 2, now });
    assert.equal(http3.ok, false);

    const actions = db.state.rateBuckets.map((b) => b.action).sort();
    assert.deepEqual(actions, [MCP_HTTP_ACTION, MCP_AUDIT_ACTION, MCP_SCAN_STORE_ACTION].sort());
  });

  it("enforces the workspace HTTP RPC limit on POST /mcp", async () => {
    const db = createFakeDb();
    const ws = db.addWorkspace();
    const created = await createApiKey(db, { workspaceId: ws.id, entitlements: getEntitlements(null), name: "k" });
    async function ping() {
      const req = new Request("https://mcp.test.agenticaso.com/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${created.key}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
      });
      return handleMcpHttp(req, { db, enabled: true, mcpHttpLimit: 1 });
    }
    assert.equal((await ping()).status, 200);
    const limited = await ping();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("Access-Control-Allow-Origin"), "*");
  });
});

describe("API-key secrecy and safe errors", () => {
  it("sanitizeErrorMessage redacts MCP secrets and never echoes plaintext keys", () => {
    const secret = "aso_test_abcdefghijklmnopqrstuv";
    assert.equal(sanitizeErrorMessage(`failed for ${secret}`), "Request failed.");
    assert.equal(sanitizeErrorMessage("Authorization: Bearer abc"), "Request failed.");
    assert.equal(sanitizeErrorMessage("MCP_KEY_PEPPER leaked"), "Request failed.");
    assert.equal(sanitizeErrorMessage("plain validation hint"), "plain validation hint");
  });

  it("rejects oversized MCP request bodies", async () => {
    const db = createFakeDb();
    const ws = db.addWorkspace();
    const created = await createApiKey(db, { workspaceId: ws.id, entitlements: getEntitlements(null) });
    const huge = "x".repeat(MCP_MAX_REQUEST_BYTES + 10);
    const req = new Request("https://mcp.test.agenticaso.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${created.key}`,
      },
      body: huge,
    });
    const res = await handleMcpHttp(req, { db, enabled: true });
    assert.equal(res.status, 413);
  });

  it("strips raw answer fields and caps MCP tool JSON size", () => {
    const leaked = mcpToolJson({ id: "a1", answer: "SECRET_RAW_ANSWER", nested: { answer: "nope" } });
    assert.equal(leaked.content[0].text.includes("SECRET_RAW_ANSWER"), false);
    assert.equal(leaked.content[0].text.includes("nope"), false);

    const huge = mcpToolJson({ pad: "n".repeat(MCP_MAX_TOOL_JSON_CHARS) });
    assert.equal(huge.isError, true);
    const body = JSON.parse(huge.content[0].text);
    assert.equal(body.code, "OUTPUT_TOO_LARGE");
  });
});

describe("SSRF, CORS, Clerk skip, feature flag", () => {
  it("rejects private, IPv6, userinfo, and .localhost URLs", () => {
    for (const url of [
      "http://localhost",
      "http://127.0.0.1",
      "http://192.168.0.8",
      "http://[::1]/",
      "http://user:pass@example.com",
      "http://app.localhost",
      "ftp://example.com",
    ]) {
      assert.equal(validateStoreUrl(url).ok, false, url);
    }
    assert.equal(validateStoreUrl("https://acmefoods.com").ok, true);
  });

  it("401 responses include CORS and allow the Authorization header", async () => {
    const res = await handleMcpHttp(
      new Request("https://mcp.test.agenticaso.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      { db: createFakeDb(), enabled: true }
    );
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    assert.match(res.headers.get("Access-Control-Allow-Headers") || "", /Authorization/i);
    assert.equal(res.headers.get("Set-Cookie"), null);
  });

  it("isMcpProtocolPath matches /mcp only (not /api/mcp/keys)", () => {
    assert.equal(isMcpProtocolPath("/mcp"), true);
    assert.equal(isMcpProtocolPath("/mcp/"), true);
    assert.equal(isMcpProtocolPath("/api/mcp/keys"), false);
    assert.equal(isMcpProtocolPath("/dashboard"), false);
  });

  it("proxy matcher excludes /mcp and never calls auth.protect", () => {
    const src = fs.readFileSync(path.join(repoRoot, "proxy.js"), "utf8");
    assert.match(src, /mcp\(\?:\/\|\$\)/);
    assert.equal(src.includes("auth.protect"), false);
  });

  it("repository keeps MCP_ENABLED=false", () => {
    const example = fs.readFileSync(path.join(repoRoot, ".env.example"), "utf8");
    assert.match(example, /^MCP_ENABLED=false$/m);
    const v2 = fs.readFileSync(path.join(repoRoot, "app/api/visibility/v2/route.js"), "utf8");
    assert.match(v2, /runVisibilityAuditV2/);
    assert.equal(v2.includes("handleMcpHttp"), false);
    assert.match(v2, /auth\(\)/);
  });
});
