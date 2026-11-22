import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { chargeProviderAttempt, readProviderBudgetConfig } from "../provider-budget.js";

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error("DATABASE_URL missing");
let target;
try {
  target = new URL(connection);
} catch {
  throw new Error("DATABASE_URL malformed");
}
assert.equal(target.hostname, "127.0.0.1");
assert.equal(target.port, "55432");
assert.equal(target.pathname, "/agenticaso_integration_test");
assert.equal(target.username, "agenticaso_test_admin");

const runId = randomUUID();
const holderApplicationName = applicationName("budget-lock-holder", runId);
const chargeApplicationName = applicationName("budget-charge", runId);
const observerApplicationName = applicationName("budget-lock-observer", runId);
const prisma = new PrismaClient();
const holder = new PrismaClient({
  datasources: { db: { url: withApplicationName(connection, holderApplicationName) } },
});
const charger = new PrismaClient({
  datasources: { db: { url: withApplicationName(connection, chargeApplicationName) } },
});
const observer = new PrismaClient({
  datasources: { db: { url: withApplicationName(connection, observerApplicationName) } },
});
const createdDays = [];
const createdScanIds = [];
const lockWaitMs = 2500;
let releaseHolder = () => {};
let holderDone = Promise.resolve();
let chargePromise;

try {
  const identity = await prisma.$queryRaw`
    SELECT current_database() AS database,
           current_user AS username,
           inet_server_addr()::text AS address,
           inet_server_port() AS port
  `;
  assert.equal(identity[0].database, "agenticaso_integration_test");
  assert.equal(identity[0].username, "agenticaso_test_admin");
  assert.equal(identity[0].address, "127.0.0.1/32");
  assert.equal(Number(identity[0].port), 55432);

  const daily = readProviderBudgetConfig({
    AI_PROVIDER_EXECUTION: "enabled",
    AI_PROVIDER_MAX_CALLS_PER_SCAN: "2",
    AI_PROVIDER_ESTIMATED_CENTS_PER_CALL: "5",
    AI_PROVIDER_MAX_CENTS_PER_SCAN: "10",
    AI_PROVIDER_MAX_CENTS_PER_DAY: "5",
    AI_PROVIDER_TIMEOUT_MS: "1000",
    AI_PROVIDER_MAX_RETRIES: "0",
  });
  assert.equal(daily.ok, true);
  const dailyDay = `budget-day-${randomUUID()}`;
  const blockedScan = randomUUID();
  await insertDay(dailyDay, 1, 5);
  await insertScan(blockedScan, dailyDay, daily);
  const beforeCharge = await readSpend(dailyDay, [blockedScan]);
  const held = defer();
  const releaseGate = defer();
  releaseHolder = () => releaseGate.resolve();
  holderDone = holder.$transaction(async (tx) => {
    const locked = await tx.$queryRaw`
      SELECT "spentCents"
      FROM "AiProviderSpendDay"
      WHERE "day" = ${dailyDay}
      FOR UPDATE
    `;
    assert.equal(locked.length, 1);
    held.resolve();
    await releaseGate.promise;
  }, { maxWait: 5000, timeout: 15000 });
  let holderTimer;
  const holderDeadline = new Promise((_, reject) => {
    holderTimer = setTimeout(() => reject(new Error("lock holder did not acquire AiProviderSpendDay")), lockWaitMs);
  });
  try {
    await Promise.race([held.promise, holderDeadline]);
  } finally {
    clearTimeout(holderTimer);
  }
  chargePromise = chargeProviderAttempt(charger, {
    scanId: blockedScan,
    day: dailyDay,
    config: daily,
    db: charger,
  });
  await observeChargeLockWait(observer);
  releaseHolder();
  const deniedDaily = await chargePromise;
  chargePromise = undefined;
  assert.equal(deniedDaily.ok, false);
  assert.equal(deniedDaily.reason, "daily_budget_exceeded");
  const dailySpent = await readSpend(dailyDay, [blockedScan]);
  assert.deepEqual(dailySpent, beforeCharge);
  assert.equal(dailySpent.dayCents, 5);
  assert.equal(dailySpent.dayCalls, 1);
  assert.equal(dailySpent.scans[0].spentCents, 0);
  assert.equal(dailySpent.scans[0].spentCalls, 0);

  const scanConfig = readProviderBudgetConfig({
    AI_PROVIDER_EXECUTION: "enabled",
    AI_PROVIDER_MAX_CALLS_PER_SCAN: "2",
    AI_PROVIDER_ESTIMATED_CENTS_PER_CALL: "5",
    AI_PROVIDER_MAX_CENTS_PER_SCAN: "5",
    AI_PROVIDER_MAX_CENTS_PER_DAY: "50",
    AI_PROVIDER_TIMEOUT_MS: "1000",
    AI_PROVIDER_MAX_RETRIES: "0",
  });
  assert.equal(scanConfig.ok, true);
  assert.equal(scanConfig.maxCents, 5);
  assert.equal(scanConfig.dailyCents, 50);
  const scanDay = `budget-scan-${randomUUID()}`;
  const limitedScan = randomUUID();
  await insertDay(scanDay);
  await insertScan(limitedScan, scanDay, scanConfig);
  const allowed = await chargeProviderAttempt(prisma, {
    scanId: limitedScan,
    day: scanDay,
    config: scanConfig,
    db: prisma,
  });
  assert.equal(allowed.ok, true);
  const beforeDenial = await readSpend(scanDay, [limitedScan]);
  const denied = await chargeProviderAttempt(prisma, {
    scanId: limitedScan,
    day: scanDay,
    config: scanConfig,
    db: prisma,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "scan_budget_exceeded");
  const afterDenial = await readSpend(scanDay, [limitedScan]);
  assert.deepEqual(afterDenial, beforeDenial);
  assert.equal(afterDenial.dayCents, 5);
  assert.equal(afterDenial.dayCalls, 1);
  assert.equal(afterDenial.scans[0].spentCents, 5);
  assert.equal(afterDenial.scans[0].spentCalls, 1);
} finally {
  releaseHolder();
  if (chargePromise) await chargePromise.catch(() => {});
  await holderDone.catch(() => {});
  for (const id of createdScanIds) {
    await prisma.$executeRaw`DELETE FROM "AiProviderScanBudget" WHERE "id" = ${id}`;
  }
  for (const day of createdDays) {
    await prisma.$executeRaw`DELETE FROM "AiProviderSpendDay" WHERE "day" = ${day}`;
  }
  await Promise.all([
    prisma.$disconnect(),
    holder.$disconnect(),
    charger.$disconnect(),
    observer.$disconnect(),
  ]);
}

async function insertDay(day, spentCalls = 0, spentCents = 0) {
  await prisma.$executeRaw`
    INSERT INTO "AiProviderSpendDay" ("day", "spentCalls", "spentCents", "updatedAt")
    VALUES (${day}, ${spentCalls}, ${spentCents}, NOW())
  `;
  createdDays.push(day);
}

function applicationName(prefix, id) {
  const name = `${prefix}-${id}`;
  if (Buffer.byteLength(name) > 63) {
    throw new Error("application_name exceeds PostgreSQL's 63-byte limit");
  }
  return name;
}

function withApplicationName(rawUrl, name) {
  const url = new URL(rawUrl);
  url.searchParams.set("application_name", name);
  return url.toString();
}

function defer() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function observeChargeLockWait(client) {
  const deadline = Date.now() + lockWaitMs;
  while (Date.now() < deadline) {
    const rows = await client.$queryRaw`
      SELECT state, wait_event_type, wait_event, query
      FROM pg_stat_activity
      WHERE application_name = ${chargeApplicationName}
        AND datname = current_database()
    `;
    const active = rows.filter((row) => row.state === "active");
    if (active.some((row) => row.query == null && row.wait_event_type == null)) {
      throw new Error("pg_stat_activity does not expose other sessions' wait state; cannot prove the AiProviderSpendDay lock");
    }
    const waiting = active.find((row) =>
      row.wait_event_type === "Lock" && String(row.query || "").includes("AiProviderSpendDay")
    );
    if (waiting) return waiting;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("charge transaction was not observed waiting on AiProviderSpendDay before the deadline");
}

async function insertScan(id, day, config) {
  await prisma.$executeRaw`
    INSERT INTO "AiProviderScanBudget" (
      "id", "day", "spentCalls", "spentCents", "maxCalls", "maxCents", "createdAt"
    ) VALUES (
      ${id}, ${day}, 0, 0, ${config.maxCalls}, ${config.maxCents}, NOW()
    )
  `;
  createdScanIds.push(id);
}

async function readSpend(day, scanIds) {
  const dayRows = await prisma.$queryRaw`
    SELECT "spentCalls", "spentCents" FROM "AiProviderSpendDay" WHERE "day" = ${day}
  `;
  const scans = [];
  for (const id of scanIds) {
    const rows = await prisma.$queryRaw`
      SELECT "spentCalls", "spentCents" FROM "AiProviderScanBudget" WHERE "id" = ${id}
    `;
    scans.push({
      spentCalls: Number(rows[0].spentCalls),
      spentCents: Number(rows[0].spentCents),
    });
  }
  return {
    dayCalls: Number(dayRows[0].spentCalls),
    dayCents: Number(dayRows[0].spentCents),
    scans,
  };
}
