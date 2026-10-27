/**
 * MCP API-key lifecycle. Plaintext secrets are returned only from createApiKey.
 * Never log or persist plaintext keys.
 */
import crypto from "node:crypto";
import { upgradePayload } from "../billing/entitlements.js";
import {
  MCP_ACTIVE_KEYS_PAID,
  MCP_DEFAULT_SCOPES,
  MCP_KEY_DISPLAY_PREFIX_LENGTH,
  MCP_KEY_LIVE_PREFIX,
  MCP_KEY_NAME_MAX,
  MCP_KEY_RANDOM_BYTES,
  MCP_KEY_TEST_PREFIX,
  getMcpKeyPepper,
  isMcpKeyFormat,
  maxActiveMcpKeys,
} from "./config.js";

function pepperMissingError() {
  const err = new Error("MCP is not configured yet.");
  err.code = "MCP_PEPPER_MISSING";
  err.status = 503;
  return err;
}

/**
 * HMAC-SHA256(MCP_KEY_PEPPER, plaintext) as hex.
 * @param {string} plaintext
 * @param {string} [pepper]
 */
export function hashApiKey(plaintext, pepper = getMcpKeyPepper()) {
  if (!pepper) throw pepperMissingError();
  const raw = String(plaintext || "");
  return crypto.createHmac("sha256", pepper).update(raw, "utf8").digest("hex");
}

/**
 * Constant-time compare of a plaintext secret against a stored hash.
 * @param {string} plaintext
 * @param {string} storedHash
 * @param {string} [pepper]
 */
export function verifyApiKeyHash(plaintext, storedHash, pepper = getMcpKeyPepper()) {
  if (!pepper || !storedHash) return false;
  let computed;
  try {
    computed = hashApiKey(plaintext, pepper);
  } catch {
    return false;
  }
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(String(storedHash), "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

export function generateApiKeySecret(nodeEnv = process.env.NODE_ENV) {
  const token = crypto.randomBytes(MCP_KEY_RANDOM_BYTES).toString("base64url");
  const kindPrefix = nodeEnv === "production" ? MCP_KEY_LIVE_PREFIX : MCP_KEY_TEST_PREFIX;
  return `${kindPrefix}${token}`;
}

export function keyDisplayPrefix(secret) {
  return String(secret || "").slice(0, MCP_KEY_DISPLAY_PREFIX_LENGTH);
}

/**
 * Safe JSON for clients — never includes keyHash or plaintext.
 * @param {object} row
 */
export function toPublicApiKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    status: row.status,
    scopes: Array.isArray(row.scopes) ? row.scopes : MCP_DEFAULT_SCOPES.slice(),
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt || null,
    revokedAt: row.revokedAt || null,
    expiresAt: row.expiresAt || null,
  };
}

export async function countActiveApiKeys(db, workspaceId) {
  return db.apiKey.count({
    where: { workspaceId, status: "active" },
  });
}

/**
 * @returns {{ ok: true, limit: number, used: number } | { ok: false, status: number, body: object }}
 */
export function assertActiveKeyLimit(entitlements, activeCount) {
  const limit = maxActiveMcpKeys(entitlements);
  const used = Math.max(0, Number(activeCount) || 0);
  if (used < limit) return { ok: true, limit, used };

  if (entitlements?.isPaid !== true) {
    const upgrade = upgradePayload({
      planId: entitlements?.planId || "free",
      feature: "mcpActiveKeys",
      used,
      limit,
      message: `You've used ${used}/${limit} MCP API keys. Upgrade to Pro for up to ${MCP_ACTIVE_KEYS_PAID} active keys.`,
    });
    return { ok: false, status: 402, body: upgrade };
  }

  return {
    ok: false,
    status: 422,
    body: {
      error: `You've reached the maximum of ${limit} active MCP API keys. Revoke an unused key to create another.`,
      limit,
      used,
    },
  };
}

function parseExpiresAt(raw) {
  if (raw == null || raw === "") return { ok: true, value: null };
  const d = raw instanceof Date ? raw : new Date(String(raw));
  if (Number.isNaN(d.getTime())) {
    return { ok: false, error: "expiresAt must be a valid ISO date." };
  }
  if (d.getTime() <= Date.now()) {
    return { ok: false, error: "expiresAt must be in the future." };
  }
  return { ok: true, value: d };
}

function normalizeName(name) {
  const trimmed = String(name || "").trim().slice(0, MCP_KEY_NAME_MAX);
  return trimmed || "MCP key";
}

/**
 * Create a key. Plaintext is on `key` only in this return value — caller must not log it.
 * @returns {Promise<{ ok: true, apiKey: object, key: string } | { ok: false, status: number, body: object }>}
 */
export async function createApiKey(db, { workspaceId, entitlements, name, expiresAt } = {}) {
  if (!workspaceId) {
    return { ok: false, status: 401, body: { error: "Please sign in." } };
  }
  if (!getMcpKeyPepper()) {
    return { ok: false, status: 503, body: { error: "MCP is not configured yet." } };
  }

  const exp = parseExpiresAt(expiresAt);
  if (!exp.ok) return { ok: false, status: 422, body: { error: exp.error } };

  const activeCount = await countActiveApiKeys(db, workspaceId);
  const limit = assertActiveKeyLimit(entitlements, activeCount);
  if (!limit.ok) return limit;

  const plaintext = generateApiKeySecret();
  const keyHash = hashApiKey(plaintext);
  const row = await db.apiKey.create({
    data: {
      workspaceId,
      name: normalizeName(name),
      prefix: keyDisplayPrefix(plaintext),
      keyHash,
      status: "active",
      scopes: MCP_DEFAULT_SCOPES.slice(),
      expiresAt: exp.value,
    },
  });

  return { ok: true, apiKey: toPublicApiKey(row), key: plaintext };
}

export async function listApiKeys(db, { workspaceId, entitlements } = {}) {
  if (!workspaceId) {
    return { ok: false, status: 401, body: { error: "Please sign in." } };
  }

  const rows = await db.apiKey.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      prefix: true,
      status: true,
      scopes: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
      expiresAt: true,
    },
  });

  const activeCount = await countActiveApiKeys(db, workspaceId);
  return {
    ok: true,
    apiKeys: rows.map(toPublicApiKey),
    limit: maxActiveMcpKeys(entitlements),
    activeCount,
  };
}

/**
 * Soft-revoke. Other workspaces see NOT_FOUND (no existence leak).
 */
export async function revokeApiKey(db, { workspaceId, keyId } = {}) {
  if (!workspaceId) {
    return { ok: false, status: 401, body: { error: "Please sign in." } };
  }
  const id = String(keyId || "").trim();
  if (!id) return { ok: false, status: 422, body: { error: "Missing key id." } };

  const existing = await db.apiKey.findFirst({
    where: { id, workspaceId },
    select: {
      id: true,
      name: true,
      prefix: true,
      status: true,
      scopes: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
      expiresAt: true,
    },
  });
  if (!existing) {
    return { ok: false, status: 404, body: { error: "Not found." } };
  }

  if (existing.status === "revoked") {
    return { ok: true, apiKey: toPublicApiKey(existing) };
  }

  const row = await db.apiKey.update({
    where: { id: existing.id },
    data: { status: "revoked", revokedAt: new Date() },
  });
  return { ok: true, apiKey: toPublicApiKey(row) };
}

function isUsableActiveKey(row, now = new Date()) {
  if (!row || row.status !== "active") return false;
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= now.getTime()) return false;
  return true;
}

/**
 * Resolve a Bearer secret to workspace + public key metadata.
 * Never returns plaintext or keyHash.
 * @returns {Promise<null | { workspace: object, apiKey: object }>}
 */
export async function resolveActiveApiKey(db, plaintext, { now = new Date(), pepper = getMcpKeyPepper() } = {}) {
  if (!db || !pepper || !isMcpKeyFormat(plaintext)) return null;

  let keyHash;
  try {
    keyHash = hashApiKey(plaintext, pepper);
  } catch {
    return null;
  }

  const row = await db.apiKey.findUnique({
    where: { keyHash },
    include: { workspace: true },
  });
  if (!row?.workspace) return null;
  if (!verifyApiKeyHash(plaintext, row.keyHash, pepper)) return null;
  if (!isUsableActiveKey(row, now)) return null;

  try {
    await db.apiKey.update({
      where: { id: row.id },
      data: { lastUsedAt: now },
    });
  } catch {
    /* lastUsedAt is best-effort */
  }

  return {
    workspace: row.workspace,
    apiKey: toPublicApiKey({ ...row, lastUsedAt: now }),
  };
}

/**
 * Shared pre-check for Clerk-authenticated key management routes.
 */
export function mcpKeysPrecheck({ enabled, signedIn, dbConfigured, workspaceId } = {}) {
  if (!enabled) {
    return { ok: false, status: 404, body: { error: "Not found." } };
  }
  if (!signedIn) {
    return { ok: false, status: 401, body: { error: "Please sign in." } };
  }
  if (!dbConfigured || !workspaceId) {
    return { ok: false, status: 503, body: { error: "Database is not configured yet." } };
  }
  return { ok: true };
}
