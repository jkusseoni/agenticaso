/**
 * CartRenew dogfood helpers. Campaign is DATA, not encoded prospect claims.
 * Does not discover URLs or send outreach.
 */

import fs from "node:fs";
import path from "node:path";
import { SIGNAL_KEYS } from "./commerce-signals.js";
import { createCampaignData, normalizeProspectIdentity } from "./persistence.js";

export const CARTRENEW_DOGFOOD_CAMPAIGN = Object.freeze({
  name: "CartRenew dogfood",
  status: "active",
  productName: "CartRenew",
  productUrl: "https://cartrenew.com",
  productDescription:
    "CartRenew is a WhatsApp checkout-recovery product for WooCommerce merchants. It lets a store follow up with shoppers after an incomplete checkout using WhatsApp. This text describes the product and ICP; it is not evidence about any prospect.",
  goal: "identify WooCommerce stores where WhatsApp cart-recovery could plausibly be relevant",
  qualificationGoal: "conversation",
  targetPlatform: "woocommerce",
  desiredSignals: Object.freeze([
    "subscriptions",
    "high_ticket",
    "international",
    "multiple_payments",
    "shipping_complexity",
    "repeat_purchase",
  ]),
});

const PRIVATE_HOST =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|::1$)/i;

function readEnvFileValue(filePath, key) {
  if (!fs.existsSync(filePath)) return "";
  const txt = fs.readFileSync(filePath, "utf8");
  const m = txt.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!m) return "";
  return m[1].trim().replace(/^['"]|['"]$/g, "");
}

export function loadConfiguredDatabaseUrl(env = process.env, cwd = process.cwd()) {
  return (
    env.GROWTH_DOGFOOD_DATABASE_URL ||
    readEnvFileValue(path.join(cwd, ".env.local"), "GROWTH_DOGFOOD_DATABASE_URL") ||
    readEnvFileValue(path.join(cwd, ".env"), "GROWTH_DOGFOOD_DATABASE_URL") ||
    readEnvFileValue(path.join(cwd, ".env.local"), "DATABASE_URL") ||
    readEnvFileValue(path.join(cwd, ".env"), "DATABASE_URL") ||
    env.DATABASE_URL ||
    ""
  );
}

/** Staging/dogfood URL only — never falls back to production DATABASE_URL. */
export function loadDogfoodDatabaseUrl(env = process.env, cwd = process.cwd()) {
  return (
    env.GROWTH_DOGFOOD_DATABASE_URL ||
    readEnvFileValue(path.join(cwd, ".env.local"), "GROWTH_DOGFOOD_DATABASE_URL") ||
    readEnvFileValue(path.join(cwd, ".env"), "GROWTH_DOGFOOD_DATABASE_URL") ||
    ""
  );
}

export function classifyDatabaseUrl(raw, env = process.env) {
  const explicit = String(env.GROWTH_DOGFOOD_ENV || "").trim().toLowerCase();
  if (["local", "staging", "non-production", "production"].includes(explicit)) {
    const classification = explicit === "non-production" ? "staging/non-production" : explicit;
    return redactDatabase(raw, classification, "explicit GROWTH_DOGFOOD_ENV");
  }
  if (!raw) {
    return { ok: false, classification: "unknown", host: null, database: null, error: "DATABASE_URL unset" };
  }
  let host = "";
  let database = "";
  try {
    const u = new URL(String(raw).replace(/^postgresql:/i, "http:"));
    host = u.hostname;
    database = (u.pathname || "").replace(/^\//, "").split("?")[0];
  } catch {
    return { ok: false, classification: "unknown", host: null, database: null, error: "unparseable DATABASE_URL" };
  }
  if (/^(localhost|127\.0\.0\.1)$/i.test(host)) {
    return redactDatabase(raw, "local", "loopback host");
  }
  if (/\bstaging\b|\bpreview\b|\bstg\./i.test(host) || /_staging|_stg/i.test(database)) {
    return redactDatabase(raw, "staging/non-production", "staging marker in host/db");
  }
  if (/\.neon\.tech$/i.test(host) || /\.supabase\.co$/i.test(host)) {
    return redactDatabase(raw, "production", "hosted provider without GROWTH_DOGFOOD_ENV override");
  }
  return redactDatabase(raw, "production", "non-local host default");
}

function redactDatabase(raw, classification, reason) {
  let host = null;
  let database = null;
  try {
    const u = new URL(String(raw).replace(/^postgresql:/i, "http:"));
    host = redactHost(u.hostname);
    database = (u.pathname || "").replace(/^\//, "").split("?")[0] || null;
  } catch {
    host = null;
  }
  return { ok: true, classification, host, database, reason };
}

export function redactHost(hostname) {
  const host = String(hostname || "");
  if (!host) return null;
  if (/^(localhost|127\.0\.0\.1)$/i.test(host)) return host;
  const parts = host.split(".");
  if (parts.length < 2) return `${host.slice(0, 4)}…`;
  const first = parts[0].length <= 12 ? parts[0] : `${parts[0].slice(0, 8)}…`;
  return `${first}.…${parts.slice(-2).join(".")}`;
}

export function redactId(id) {
  const s = String(id || "");
  if (s.length <= 8) return s ? `${s.slice(0, 2)}…` : null;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

export function parseDogfoodUrls(raw) {
  const parts = String(raw || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length > 3) {
    return { ok: false, error: "at_most_three_urls", urls: [] };
  }
  return { ok: true, urls: parts };
}

export function validateDogfoodUrl(raw) {
  const identity = normalizeProspectIdentity(raw);
  if (!identity.ok) return identity;
  const host = identity.canonicalDomain;
  if (PRIVATE_HOST.test(host) || host.endsWith(".internal") || host.endsWith(".local")) {
    return { ok: false, error: "private_or_internal_host" };
  }
  const m = host.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) {
    return { ok: false, error: "private_or_internal_host" };
  }
  return identity;
}

export function buildCartRenewCampaignData(workspaceId) {
  const data = createCampaignData(workspaceId, {
    name: CARTRENEW_DOGFOOD_CAMPAIGN.name,
    status: CARTRENEW_DOGFOOD_CAMPAIGN.status,
    productProfile: {
      product: {
        name: CARTRENEW_DOGFOOD_CAMPAIGN.productName,
        url: CARTRENEW_DOGFOOD_CAMPAIGN.productUrl,
        description: CARTRENEW_DOGFOOD_CAMPAIGN.productDescription,
      },
      goal: CARTRENEW_DOGFOOD_CAMPAIGN.qualificationGoal,
      targetPlatform: CARTRENEW_DOGFOOD_CAMPAIGN.targetPlatform,
      desiredSignals: [...CARTRENEW_DOGFOOD_CAMPAIGN.desiredSignals],
    },
  });
  data.goal = CARTRENEW_DOGFOOD_CAMPAIGN.goal;
  data.desiredSignals = CARTRENEW_DOGFOOD_CAMPAIGN.desiredSignals.filter((k) => SIGNAL_KEYS.includes(k));
  return data;
}

export function isDogfoodConfirm(env = process.env) {
  return String(env.GROWTH_DOGFOOD_CONFIRM || "") === "YES";
}

export function writesAllowed(classification, env = process.env) {
  if (!isDogfoodConfirm(env)) return { ok: false, reason: "missing_GROWTH_DOGFOOD_CONFIRM" };
  if (classification === "production") return { ok: false, reason: "PRODUCTION_DB_APPROVAL_REQUIRED" };
  if (classification !== "local" && classification !== "staging" && classification !== "staging/non-production") {
    return { ok: false, reason: "unapproved_environment" };
  }
  return { ok: true };
}

/**
 * Build an idempotent seed plan. Does not write.
 */
export function planDogfoodSeed({ workspaceId, urls = [], existing = {} } = {}) {
  if (!workspaceId) {
    return { ok: false, error: "missing_workspace_id" };
  }
  const parsed = parseDogfoodUrls(Array.isArray(urls) ? urls.join(",") : urls);
  if (!parsed.ok) return parsed;

  const identities = [];
  for (const url of parsed.urls) {
    const identity = validateDogfoodUrl(url);
    if (!identity.ok) {
      return { ok: false, error: identity.error, url };
    }
    identities.push(identity);
  }

  const campaignData = buildCartRenewCampaignData(workspaceId);
  const campaignExists = Boolean(existing.campaignId);
  const prospects = identities.map((identity) => {
    const already = (existing.prospects || []).some((p) => p.canonicalDomain === identity.canonicalDomain);
    const hasResearchJob = already && (existing.researchJobs || []).some((j) => j.canonicalDomain === identity.canonicalDomain);
    return {
      identity,
      createProspect: !already,
      createResearchJob: !hasResearchJob,
      lifecycleState: "research_pending",
    };
  });

  return {
    ok: true,
    campaignData,
    campaignExists,
    createCampaign: !campaignExists,
    prospects,
    wouldCreate: {
      campaigns: campaignExists ? 0 : 1,
      prospects: prospects.filter((p) => p.createProspect).length,
      researchJobs: prospects.filter((p) => p.createResearchJob).length,
    },
  };
}
