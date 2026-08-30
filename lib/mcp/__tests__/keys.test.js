/**
 * MCP V1 Phase A — API key hashing, lifecycle, limits, isolation.
 * No MCP protocol server in this phase.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { getEntitlements, PLAN_IDS } from "../../billing/index.js";
import {
  MCP_ACTIVE_KEYS_FREE,
  MCP_ACTIVE_KEYS_PAID,
  createApiKey,
  generateApiKeySecret,
  hashApiKey,
  isMcpEnabled,
  isMcpKeyFormat,
  keyDisplayPrefix,
  listApiKeys,
  maxActiveMcpKeys,
  mcpKeysPrecheck,
  resolveActiveApiKey,
  revokeApiKey,
  toPublicApiKey,
  verifyApiKeyHash,
} from "../index.js";

const PREV_PEPPER = process.env.MCP_KEY_PEPPER;
const PREV_ENABLED = process.env.MCP_ENABLED;
const TEST_PEPPER = "unit-test-mcp-pepper-not-for-production";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

before(() => {
  process.env.MCP_KEY_PEPPER = TEST_PEPPER;
  process.env.MCP_ENABLED = "false";
});

after(() => {
  if (PREV_PEPPER == null) delete process.env.MCP_KEY_PEPPER;
  else process.env.MCP_KEY_PEPPER = PREV_PEPPER;
  if (PREV_ENABLED == null) delete process.env.MCP_ENABLED;
  else process.env.MCP_ENABLED = PREV_ENABLED;
});

function genId() {
  return `id_${Math.random().toString(36).slice(2, 12)}`;
}

function createFakeDb() {
  const state = { workspaces: [], apiKeys: [] };
  return {
    state,
    addWorkspace(partial = {}) {
      const row = {
        id: partial.id || genId(),
        clerkUserId: partial.clerkUserId || `user_${genId()}`,
        email: partial.email || null,
      };
      state.workspaces.push(row);
      return row;
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
      async findMany({ where, orderBy, select }) {
        let rows = state.apiKeys.filter((k) => {
          if (where?.workspaceId && k.workspaceId !== where.workspaceId) return false;
          return true;
        });
        if (orderBy?.createdAt === "desc") {
          rows = [...rows].sort((a, b) => b.createdAt - a.createdAt);
        }
        if (select) {
          rows = rows.map((r) => {
            const o = {};
            for (const key of Object.keys(select)) {
              if (select[key]) o[key] = r[key];
            }
            return o;
          });
        }
        return rows;
      },
      async findFirst({ where }) {
        return (
          state.apiKeys.find((k) => {
            if (where.id && k.id !== where.id) return false;
            if (where.workspaceId && k.workspaceId !== where.workspaceId) return false;
            if (where.status && k.status !== where.status) return false;
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
    },
  };
}

const freeEntitlements = getEntitlements(null);
const proEntitlements = getEntitlements({
  plan: PLAN_IDS.PRO,
  status: "active",
  provider: "paddle",
  providerSubscriptionId: "sub_verified_test",
  currentPeriodEnd: new Date(Date.now() + 86400_000),
});

describe("MCP feature flag", () => {
  it("is disabled unless MCP_ENABLED is exactly true", () => {
    assert.equal(isMcpEnabled({ MCP_ENABLED: "false" }), false);
    assert.equal(isMcpEnabled({ MCP_ENABLED: "" }), false);
    assert.equal(isMcpEnabled({}), false);
    assert.equal(isMcpEnabled({ MCP_ENABLED: "true" }), true);
  });

  it("ships key management, POST /mcp, and the official MCP SDK", () => {
    assert.ok(fs.existsSync(path.join(repoRoot, "app/api/mcp/keys/route.js")));
    assert.ok(fs.existsSync(path.join(repoRoot, "app/api/mcp/keys/[id]/route.js")));
    assert.ok(fs.existsSync(path.join(repoRoot, "app/mcp/route.js")));
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    assert.ok(pkg.dependencies?.["@modelcontextprotocol/sdk"]);
  });
});

describe("key hashing and verification", () => {
  it("generates aso_test_ secrets in non-production and hashes with pepper", () => {
    const secret = generateApiKeySecret("test");
    assert.equal(isMcpKeyFormat(secret), true);
    assert.match(secret, /^aso_test_/);
    const digest = hashApiKey(secret, TEST_PEPPER);
    assert.equal(digest.length, 64);
    assert.equal(verifyApiKeyHash(secret, digest, TEST_PEPPER), true);
    assert.equal(keyDisplayPrefix(secret).length, 12);
  });

  it("uses HMAC-SHA256 so the same secret hashes differently with another pepper", () => {
    const secret = generateApiKeySecret("test");
    const a = hashApiKey(secret, TEST_PEPPER);
    const b = hashApiKey(secret, "another-pepper-value");
    assert.notEqual(a, b);
    assert.equal(verifyApiKeyHash(secret, a, "another-pepper-value"), false);
    assert.equal(verifyApiKeyHash("aso_test_thisisnottherealkey12", a, TEST_PEPPER), false);
  });

  it("rejects malformed secrets before resolve", () => {
    assert.equal(isMcpKeyFormat(""), false);
    assert.equal(isMcpKeyFormat("sk-openai-not-ours"), false);
    assert.equal(isMcpKeyFormat("aso_live_short"), false);
  });
});

describe("key creation", () => {
  it("returns plaintext once and stores only prefix + hash", async () => {
    const db = createFakeDb();
    const ws = db.addWorkspace();
    const created = await createApiKey(db, {
      workspaceId: ws.id,
      entitlements: freeEntitlements,
      name: "Cursor",
    });
    assert.equal(created.ok, true);
    assert.equal(isMcpKeyFormat(created.key), true);
    assert.equal(created.apiKey.prefix, keyDisplayPrefix(created.key));
    assert.equal(created.apiKey.name, "Cursor");
    assert.deepEqual(created.apiKey.scopes, ["mcp"]);
    assert.equal(created.apiKey.status, "active");
    assert.equal("keyHash" in created.apiKey, false);

    const stored = db.state.apiKeys[0];
    assert.equal(stored.keyHash, hashApiKey(created.key, TEST_PEPPER));
    assert.equal(Object.prototype.hasOwnProperty.call(stored, "key"), false);
    assert.equal(stored.name.includes(created.key), false);

    const listed = await listApiKeys(db, { workspaceId: ws.id, entitlements: freeEntitlements });
    assert.equal(listed.ok, true);
    assert.equal(listed.apiKeys.length, 1);
    assert.equal("keyHash" in listed.apiKeys[0], false);
    assert.equal(JSON.stringify(listed).includes(created.key), false);
  });

  it("uses aso_live_ in production and refuses to create without a pepper", async () => {
    const live = generateApiKeySecret("production");
    assert.match(live, /^aso_live_/);
    assert.equal(isMcpKeyFormat(live), true);

    const prev = process.env.MCP_KEY_PEPPER;
    delete process.env.MCP_KEY_PEPPER;
    try {
      const db = createFakeDb();
      const ws = db.addWorkspace();
      const created = await createApiKey(db, { workspaceId: ws.id, entitlements: freeEntitlements });
      assert.equal(created.ok, false);
      assert.equal(created.status, 503);
      assert.equal(db.state.apiKeys.length, 0);
    } finally {
      process.env.MCP_KEY_PEPPER = prev;
    }
  });

  it("ignores client-supplied scopes and default-names blank names", async () => {
    const db = createFakeDb();
    const ws = db.addWorkspace();
    const created = await createApiKey(db, {
      workspaceId: ws.id,
      entitlements: freeEntitlements,
      name: "   ",
    });
    assert.equal(created.ok, true);
    assert.equal(created.apiKey.name, "MCP key");
    assert.deepEqual(created.apiKey.scopes, ["mcp"]);
  });
});

describe("revocation and resolve", () => {
  it("resolves an active key to its workspace and fails after revoke", async () => {
    const db = createFakeDb();
    const ws = db.addWorkspace({ clerkUserId: "user_a" });
    const created = await createApiKey(db, { workspaceId: ws.id, entitlements: freeEntitlements });
    const resolved = await resolveActiveApiKey(db, created.key);
    assert.ok(resolved);
    assert.equal(resolved.workspace.id, ws.id);
    assert.equal(resolved.workspace.clerkUserId, "user_a");
    assert.equal(resolved.apiKey.id, created.apiKey.id);
    assert.equal("keyHash" in resolved.apiKey, false);

    const revoked = await revokeApiKey(db, { workspaceId: ws.id, keyId: created.apiKey.id });
    assert.equal(revoked.ok, true);
    assert.equal(revoked.apiKey.status, "revoked");
    assert.equal(await resolveActiveApiKey(db, created.key), null);

    const again = await revokeApiKey(db, { workspaceId: ws.id, keyId: created.apiKey.id });
    assert.equal(again.ok, true);
    assert.equal(again.apiKey.status, "revoked");
  });

  it("does not resolve expired keys", async () => {
    const db = createFakeDb();
    const ws = db.addWorkspace();
    const created = await createApiKey(db, {
      workspaceId: ws.id,
      entitlements: freeEntitlements,
      expiresAt: new Date(Date.now() + 60_000),
    });
    db.state.apiKeys[0].expiresAt = new Date(Date.now() - 1000);
    assert.equal(await resolveActiveApiKey(db, created.key), null);
  });
});

describe("workspace isolation", () => {
  it("cannot list or revoke another workspace's keys", async () => {
    const db = createFakeDb();
    const a = db.addWorkspace({ clerkUserId: "owner_a" });
    const b = db.addWorkspace({ clerkUserId: "owner_b" });
    const created = await createApiKey(db, { workspaceId: a.id, entitlements: freeEntitlements });

    const listedB = await listApiKeys(db, { workspaceId: b.id, entitlements: freeEntitlements });
    assert.equal(listedB.apiKeys.length, 0);

    const steal = await revokeApiKey(db, { workspaceId: b.id, keyId: created.apiKey.id });
    assert.equal(steal.ok, false);
    assert.equal(steal.status, 404);

    assert.ok(await resolveActiveApiKey(db, created.key));
    const listedA = await listApiKeys(db, { workspaceId: a.id, entitlements: freeEntitlements });
    assert.equal(listedA.apiKeys.length, 1);
  });
});

describe("active-key limits", () => {
  it("caps Free at 2 and does not count revoked keys", async () => {
    assert.equal(maxActiveMcpKeys(freeEntitlements), MCP_ACTIVE_KEYS_FREE);
    const db = createFakeDb();
    const ws = db.addWorkspace();

    const first = await createApiKey(db, { workspaceId: ws.id, entitlements: freeEntitlements, name: "one" });
    const second = await createApiKey(db, { workspaceId: ws.id, entitlements: freeEntitlements, name: "two" });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);

    const blocked = await createApiKey(db, { workspaceId: ws.id, entitlements: freeEntitlements, name: "three" });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 402);
    assert.equal(blocked.body.upgrade, true);
    assert.equal(blocked.body.feature, "mcpActiveKeys");
    assert.equal(blocked.body.suggestedPlan, "pro");

    const revoked = await revokeApiKey(db, { workspaceId: ws.id, keyId: first.apiKey.id });
    assert.equal(revoked.ok, true);

    const third = await createApiKey(db, { workspaceId: ws.id, entitlements: freeEntitlements, name: "three" });
    assert.equal(third.ok, true);
  });

  it("caps Pro at 8 with a validation error (not Agency upsell)", async () => {
    assert.equal(maxActiveMcpKeys(proEntitlements), MCP_ACTIVE_KEYS_PAID);
    const db = createFakeDb();
    const ws = db.addWorkspace();
    for (let i = 0; i < MCP_ACTIVE_KEYS_PAID; i += 1) {
      const row = await createApiKey(db, { workspaceId: ws.id, entitlements: proEntitlements, name: `k${i}` });
      assert.equal(row.ok, true);
    }
    const extra = await createApiKey(db, { workspaceId: ws.id, entitlements: proEntitlements, name: "overflow" });
    assert.equal(extra.ok, false);
    assert.equal(extra.status, 422);
    assert.equal(extra.body.upgrade, undefined);
  });
});

describe("unauthorized access", () => {
  it("precheck hides MCP when disabled and requires sign-in when enabled", () => {
    assert.deepEqual(mcpKeysPrecheck({ enabled: false, signedIn: true, dbConfigured: true, workspaceId: "ws" }), {
      ok: false,
      status: 404,
      body: { error: "Not found." },
    });
    assert.deepEqual(mcpKeysPrecheck({ enabled: true, signedIn: false, dbConfigured: true, workspaceId: "ws" }), {
      ok: false,
      status: 401,
      body: { error: "Please sign in." },
    });
    assert.deepEqual(mcpKeysPrecheck({ enabled: true, signedIn: true, dbConfigured: false, workspaceId: "ws" }), {
      ok: false,
      status: 503,
      body: { error: "Database is not configured yet." },
    });
    assert.equal(mcpKeysPrecheck({ enabled: true, signedIn: true, dbConfigured: true, workspaceId: "ws" }).ok, true);
  });

  it("create / list / revoke without a workspace are unauthorized", async () => {
    const db = createFakeDb();
    const created = await createApiKey(db, { entitlements: freeEntitlements, name: "x" });
    assert.equal(created.ok, false);
    assert.equal(created.status, 401);

    const listed = await listApiKeys(db, { entitlements: freeEntitlements });
    assert.equal(listed.ok, false);
    assert.equal(listed.status, 401);

    const revoked = await revokeApiKey(db, { keyId: "anything" });
    assert.equal(revoked.ok, false);
    assert.equal(revoked.status, 401);
  });
});

describe("public key shape", () => {
  it("toPublicApiKey never exposes keyHash", () => {
    const publicKey = toPublicApiKey({
      id: "k1",
      name: "n",
      prefix: "aso_test_abcd",
      keyHash: "should-not-leak",
      status: "active",
      scopes: ["mcp"],
      createdAt: new Date(),
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: null,
      workspaceId: "ws",
    });
    assert.equal("keyHash" in publicKey, false);
    assert.equal("workspaceId" in publicKey, false);
    assert.equal(JSON.stringify(publicKey).includes("should-not-leak"), false);
  });
});
