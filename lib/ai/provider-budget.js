import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Application-side estimate for external AI calls.
 *
 * These ceilings are not an OpenAI, Perplexity, Gemini, or AICredits account
 * cap. The provider can still bill a request this process never sees. Prices
 * are not read from the provider. Each outbound attempt is charged a
 * configurable cent estimate that is intentionally higher than a typical
 * short gpt-4o-mini reply. Set the estimate from the provider invoice, not
 * from Agenticaso AI-test credits.
 *
 * One Visibility V2 scan can call:
 * - 1 brand-identification request
 * - 1 buyer-question request
 * - 5 questions x 3 providers = 15 measurement requests
 * The legacy visibility route can call 1 + 1 + 5 x 2 = 12 requests.
 * Provider code does not retry unless AI_PROVIDER_MAX_RETRIES is 1.
 * A configured retry is used only for a timeout, a network failure, or HTTP
 * 500, 502, 503, or 504. Permanent 4xx responses, Gemini validation and block
 * errors, and budget failures are not retried.
 * Monitoring uses the same measurement path and has no extra retry loop.
 */

export const providerBudgetStorage = new AsyncLocalStorage();

const EXECUTION_ON = "enabled";
const MAX_CALLS_CAP = 20;
const MAX_SCAN_CENTS_CAP = 1000;
const MAX_DAILY_CENTS_CAP = 100_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 1;
const RETRYABLE_HTTP_STATUSES = new Set([500, 502, 503, 504]);
const BUDGET_AUTHORIZATION_ERRORS = new Set([
  "scan_budget_exceeded",
  "daily_budget_exceeded",
  "provider_budget_unverified",
]);
const NON_RETRYABLE_CODES = new Set([
  ...BUDGET_AUTHORIZATION_ERRORS,
  "ai_execution_disabled",
  "ai_provider_kill_switch",
]);
const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function readProviderBudgetConfig(env = process.env) {
  const killed = ["1", "true", "on"].includes(String(env.AI_PROVIDER_KILL_SWITCH || "").trim().toLowerCase());
  if (killed) {
    return { ok: true, enabled: false, killed: true };
  }
  if (env.AI_PROVIDER_EXECUTION !== EXECUTION_ON) {
    return { ok: true, enabled: false, killed: false };
  }

  const maxCalls = parseConfig(env.AI_PROVIDER_MAX_CALLS_PER_SCAN, 17, 1, MAX_CALLS_CAP);
  const centsPerCall = parseConfig(env.AI_PROVIDER_ESTIMATED_CENTS_PER_CALL, 5, 1, MAX_SCAN_CENTS_CAP);
  const maxScanCents = parseConfig(env.AI_PROVIDER_MAX_CENTS_PER_SCAN, 85, 1, MAX_SCAN_CENTS_CAP);
  const dailyCents = parseConfig(env.AI_PROVIDER_MAX_CENTS_PER_DAY, 500, 1, MAX_DAILY_CENTS_CAP);
  const timeoutMs = parseConfig(env.AI_PROVIDER_TIMEOUT_MS, 20_000, 1_000, MAX_TIMEOUT_MS);
  const maxRetries = parseConfig(env.AI_PROVIDER_MAX_RETRIES, 0, 0, MAX_RETRIES);
  if (![maxCalls, centsPerCall, maxScanCents, dailyCents, timeoutMs, maxRetries].every((item) => item.ok)) {
    return { ok: false, reason: "provider_budget_unverified" };
  }

  const calls = Math.min(maxCalls.value, Math.floor(maxScanCents.value / centsPerCall.value));
  if (calls < 1 || dailyCents.value < centsPerCall.value) {
    return { ok: false, reason: "provider_budget_unverified" };
  }
  return {
    ok: true,
    enabled: true,
    killed: false,
    maxCalls: calls,
    maxCents: Math.min(maxScanCents.value, calls * centsPerCall.value),
    centsPerCall: centsPerCall.value,
    dailyCents: dailyCents.value,
    timeoutMs: timeoutMs.value,
    maxRetries: maxRetries.value,
  };
}

function parseConfig(raw, fallback, min, max) {
  if (raw == null || String(raw).trim() === "") return { ok: true, value: fallback };
  if (!/^\d+$/.test(String(raw).trim())) return { ok: false };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) return { ok: false };
  return { ok: true, value };
}

export function applySpendCharge(current, charge) {
  const cents = charge.cents;
  const nextScanCalls = current.scan.spentCalls + 1;
  const nextScanCents = current.scan.spentCents + cents;
  const nextDayCalls = current.day.spentCalls + 1;
  const nextDayCents = current.day.spentCents + cents;
  if (nextScanCalls > current.scan.maxCalls || nextScanCents > current.scan.maxCents) {
    return { ok: false, reason: "scan_budget_exceeded" };
  }
  if (nextDayCents > charge.dailyCents) {
    return { ok: false, reason: "daily_budget_exceeded" };
  }
  return {
    ok: true,
    scan: { ...current.scan, spentCalls: nextScanCalls, spentCents: nextScanCents },
    day: { ...current.day, spentCalls: nextDayCalls, spentCents: nextDayCents },
  };
}

export function providerBudgetDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export async function openProviderScanBudget(db, config = readProviderBudgetConfig(), now = new Date()) {
  if (!config.ok) return { ok: false, reason: config.reason || "provider_budget_unverified" };
  if (!config.enabled) return { ok: true, enabled: false };
  if (typeof db?.$transaction !== "function") {
    return { ok: false, reason: "provider_budget_unverified" };
  }
  const id = randomUUID();
  const day = providerBudgetDay(now);
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "AiProviderSpendDay" ("day", "spentCalls", "spentCents", "updatedAt")
        VALUES (${day}, 0, 0, NOW())
        ON CONFLICT ("day") DO NOTHING
      `;
      await tx.$executeRaw`
        INSERT INTO "AiProviderScanBudget" (
          "id", "day", "spentCalls", "spentCents", "maxCalls", "maxCents", "createdAt"
        ) VALUES (
          ${id}, ${day}, 0, 0, ${config.maxCalls}, ${config.maxCents}, NOW()
        )
      `;
    });
  } catch {
    return { ok: false, reason: "provider_budget_unverified" };
  }
  return {
    ok: true,
    enabled: true,
    state: { scanId: id, day, config, db },
  };
}

export async function chargeProviderAttempt(db, state, now = new Date()) {
  const config = state?.config;
  if (!config?.enabled || !state?.scanId || typeof db?.$transaction !== "function") {
    return { ok: false, reason: "provider_budget_unverified" };
  }
  const day = state.day || providerBudgetDay(now);
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "AiProviderSpendDay" ("day", "spentCalls", "spentCents", "updatedAt")
        VALUES (${day}, 0, 0, NOW())
        ON CONFLICT ("day") DO NOTHING
      `;
      const scanRows = await tx.$queryRaw`
        SELECT "spentCalls", "spentCents", "maxCalls", "maxCents"
        FROM "AiProviderScanBudget"
        WHERE "id" = ${state.scanId}
        FOR UPDATE
      `;
      const dayRows = await tx.$queryRaw`
        SELECT "spentCalls", "spentCents"
        FROM "AiProviderSpendDay"
        WHERE "day" = ${day}
        FOR UPDATE
      `;
      if (scanRows.length !== 1 || dayRows.length !== 1) {
        return { ok: false, reason: "provider_budget_unverified" };
      }
      const next = applySpendCharge(
        {
          scan: {
            spentCalls: Number(scanRows[0].spentCalls),
            spentCents: Number(scanRows[0].spentCents),
            maxCalls: Number(scanRows[0].maxCalls),
            maxCents: Number(scanRows[0].maxCents),
          },
          day: {
            spentCalls: Number(dayRows[0].spentCalls),
            spentCents: Number(dayRows[0].spentCents),
          },
        },
        { cents: config.centsPerCall, dailyCents: config.dailyCents }
      );
      if (!next.ok) return next;
      await tx.$executeRaw`
        UPDATE "AiProviderScanBudget"
        SET "spentCalls" = ${next.scan.spentCalls},
            "spentCents" = ${next.scan.spentCents}
        WHERE "id" = ${state.scanId}
      `;
      await tx.$executeRaw`
        UPDATE "AiProviderSpendDay"
        SET "spentCalls" = ${next.day.spentCalls},
            "spentCents" = ${next.day.spentCents},
            "updatedAt" = NOW()
        WHERE "day" = ${day}
      `;
      return { ok: true };
    });
  } catch {
    return { ok: false, reason: "provider_budget_unverified" };
  }
}

export function budgetAuthorizationCode(error) {
  const code = error?.code;
  if (BUDGET_AUTHORIZATION_ERRORS.has(code)) return code;
  const message = String(error?.message || "");
  if (BUDGET_AUTHORIZATION_ERRORS.has(message)) return message;
  return null;
}

export function rethrowBudgetAuthorizationError(error) {
  const code = budgetAuthorizationCode(error);
  if (!code) return;
  if (error && !error.code) error.code = code;
  throw error;
}

export async function authorizeProviderAttempt() {
  const config = readProviderBudgetConfig();
  if (!config.ok) return { allow: false, reason: "provider_budget_unverified" };
  if (config.killed) return { allow: false, reason: "ai_provider_kill_switch" };
  if (!config.enabled) return { allow: false, reason: "ai_execution_disabled" };
  const state = providerBudgetStorage.getStore();
  if (!state?.scanId) return { allow: false, reason: "provider_budget_unverified" };
  const charged = await chargeProviderAttempt(state.db, state);
  if (!charged.ok) return { allow: false, reason: charged.reason };
  return { allow: true, timeoutMs: config.timeoutMs, maxRetries: config.maxRetries };
}

export async function runBoundedProviderAttempts(runOnce) {
  const first = await authorizeProviderAttempt();
  if (!first.allow) {
    const error = new Error(first.reason);
    error.code = first.reason;
    throw error;
  }
  let attempt = 0;
  const maxAttempts = 1 + first.maxRetries;
  let lastError;
  while (attempt < maxAttempts) {
    if (attempt > 0) {
      const retry = await authorizeProviderAttempt();
      if (!retry.allow) {
        const error = new Error(retry.reason);
        error.code = retry.reason;
        throw error;
      }
    }
    try {
      return await runOnce({ timeoutMs: first.timeoutMs, attempt });
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt >= maxAttempts || !isRetryableProviderError(error)) break;
    }
  }
  throw lastError;
}

function isRetryableProviderError(error) {
  const code = error?.code;
  const message = String(error?.message || "");
  if (NON_RETRYABLE_CODES.has(code) || NON_RETRYABLE_CODES.has(message)) return false;
  if (
    message.startsWith("gemini_incomplete:") ||
    message.startsWith("gemini_blocked:") ||
    message.startsWith("gemini_missing_candidates") ||
    message.startsWith("gemini_empty_response")
  ) {
    return false;
  }

  const status = Number(error?.status ?? error?.statusCode);
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    return RETRYABLE_HTTP_STATUSES.has(status);
  }

  if (error?.name === "AbortError" || error?.name === "TimeoutError") return true;
  const causeCode = error?.cause?.code || code;
  if (NETWORK_ERROR_CODES.has(causeCode)) return true;
  if (message === "fetch failed") return true;
  return false;
}
