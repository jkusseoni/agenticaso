/**
 * Staging-only Growth dogfood bootstrap.
 * Connects exclusively to GROWTH_DOGFOOD_DATABASE_URL.
 * Does not seed campaigns/prospects/jobs. Does not set GROWTH_DOGFOOD_CONFIRM.
 *
 * Usage: node scripts/bootstrap-growth-dogfood-workspace.js
 */
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import {
  SYNTHETIC_DOGFOOD_CLERK_USER_ID,
  SYNTHETIC_DOGFOOD_EMAIL,
  assertStagingTarget,
  loadDogfoodEnv,
} from "../lib/growth/dogfood-env.js";
import { redactId } from "../lib/growth/dogfood.js";

const APP_TABLES = [
  "Workspace",
  "Website",
  "GrowthCampaign",
  "GrowthProspect",
  "GrowthJob",
  "Subscription",
  "ApiKey",
];

function classifyContents(counts, clerkUserIds) {
  const tableNames = Object.keys(counts);
  if (tableNames.length === 0) return "EMPTY";
  const rowTotal = Object.values(counts).reduce((n, v) => n + Number(v || 0), 0);
  const workspaceCount = Number(counts.Workspace || 0);
  const looksCloned = clerkUserIds.some((id) => /^user_/i.test(String(id || "")));
  if (looksCloned || (workspaceCount > 0 && clerkUserIds.some((id) => id !== SYNTHETIC_DOGFOOD_CLERK_USER_ID))) {
    return "CLONED_FROM_PRODUCTION";
  }
  if (rowTotal === 0) return "SCHEMA_ONLY";
  if (workspaceCount <= 1 && clerkUserIds.every((id) => id === SYNTHETIC_DOGFOOD_CLERK_USER_ID)) {
    return "OTHER";
  }
  return "OTHER";
}

async function tableCounts(prisma) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);
  const names = rows.map((r) => r.tablename);
  const counts = {};
  for (const name of names) {
    if (!/^[A-Za-z0-9_]+$/.test(name)) continue;
    const quoted = `"${name}"`;
    const result = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM ${quoted}`);
    counts[name] = result[0]?.n ?? 0;
  }
  return counts;
}

const BASELINE_MIGRATIONS = [
  { name: "20260812120000_phase3_persistent_intelligence", table: "Workspace" },
  { name: "20260813000000_phase6_monitoring", table: "Monitoring" },
  { name: "20260813010000_phase7_billing", table: "Subscription" },
  { name: "20260813020000_phase71_usage_reservation", table: "UsagePeriod", column: "aiTestsReserved" },
  { name: "20260818000000_phase_mcp_v1_api_keys", table: "ApiKey" },
  { name: "20260818220000_phase_mcp_v1_rate_buckets", table: "McpRateBucket" },
  { name: "20260826120000_phase_g_fixes", table: "Fix" },
  { name: "20260827100000_phase_f_webhook_applied", table: "BillingWebhookEvent", column: "applied" },
  { name: "20260830120000_phase_f1_paddle_event_ordering", table: "Subscription", column: "lastPaddleEventAt" },
];

function sanitizeProcessOutput(text) {
  return String(text || "")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted-db-url]")
    .replace(/npg_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/\bep-[a-z0-9-]+\.[a-z0-9.-]*neon\.tech/gi, "[redacted-host]")
    .slice(0, 2000);
}

function prismaMigrateEnv(stagingUrl, directUrl) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.DIRECT_URL;
  env.DATABASE_URL = stagingUrl;
  env.DIRECT_URL = directUrl || stagingUrl;
  return env;
}

function migrateDeploy(stagingUrl, directUrl) {
  return spawnSync("npx", ["prisma", "migrate", "deploy"], {
    env: prismaMigrateEnv(stagingUrl, directUrl),
    encoding: "utf8",
    shell: true,
  });
}

function migrateStatus(stagingUrl, directUrl) {
  return spawnSync("npx", ["prisma", "migrate", "status"], {
    env: prismaMigrateEnv(stagingUrl, directUrl),
    encoding: "utf8",
    shell: true,
  });
}

function migrateResolveApplied(stagingUrl, directUrl, name) {
  return spawnSync("npx", ["prisma", "migrate", "resolve", "--applied", name], {
    env: prismaMigrateEnv(stagingUrl, directUrl),
    encoding: "utf8",
    shell: true,
  });
}

async function tableExists(prisma, table) {
  const rows = await prisma.$queryRaw`
    SELECT 1 AS ok
    FROM pg_tables
    WHERE schemaname = 'public' AND tablename = ${table}
  `;
  return rows.length > 0;
}

async function columnExists(prisma, table, column) {
  const rows = await prisma.$queryRaw`
    SELECT 1 AS ok
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
  `;
  return rows.length > 0;
}

async function baselineAlreadyPresent(prisma, spec) {
  if (!(await tableExists(prisma, spec.table))) return false;
  if (spec.column && !(await columnExists(prisma, spec.table, spec.column))) return false;
  return true;
}

async function main() {
  const loaded = loadDogfoodEnv();
  if (loaded.GROWTH_DOGFOOD_CONFIRM === "YES") {
    console.error(JSON.stringify({ ok: false, token: "STAGING_BOOTSTRAP_FAILED", error: "GROWTH_DOGFOOD_CONFIRM_must_not_be_YES_during_bootstrap" }, null, 2));
    process.exit(2);
  }
  const check = assertStagingTarget(loaded);
  if (!check.ok) {
    console.log(JSON.stringify(check, null, 2));
    process.exit(2);
  }

  const report = {
    ok: true,
    staging: {
      host: check.staging.redactedHost,
      database: check.staging.database,
      classification: check.classified.classification,
      reason: check.classified.reason,
    },
    productionCompared: {
      host: check.production.redactedHost,
      database: check.production.database,
    },
    collision: false,
    contents: null,
    clonedFromProduction: false,
    migrationStatusBefore: null,
    migrationsApplied: false,
    migrationStatusAfter: null,
    workspace: null,
    token: null,
  };

  const prisma = new PrismaClient({
    datasources: { db: { url: loaded.GROWTH_DOGFOOD_DATABASE_URL } },
  });

  try {
    let counts = {};
    try {
      counts = await tableCounts(prisma);
    } catch {
      counts = {};
    }
    let clerkUserIds = [];
    if (counts.Workspace > 0) {
      const workspaces = await prisma.workspace.findMany({ select: { clerkUserId: true } });
      clerkUserIds = workspaces.map((w) => w.clerkUserId);
    }
    report.contents = classifyContents(counts, clerkUserIds);
    report.clonedFromProduction = report.contents === "CLONED_FROM_PRODUCTION";
    report.preExistingAppRows = APP_TABLES.reduce((n, t) => n + Number(counts[t] || 0), 0);
    report.publicTableCount = Object.keys(counts).length;

    const before = migrateStatus(loaded.GROWTH_DOGFOOD_DATABASE_URL, loaded.GROWTH_DOGFOOD_DIRECT_URL);
    report.migrationStatusBefore = sanitizeProcessOutput(before.stdout || before.stderr);

    report.migrationsMarkedApplied = [];
    for (const spec of BASELINE_MIGRATIONS) {
      if (!(await baselineAlreadyPresent(prisma, spec))) continue;
      const resolved = migrateResolveApplied(
        loaded.GROWTH_DOGFOOD_DATABASE_URL,
        loaded.GROWTH_DOGFOOD_DIRECT_URL,
        spec.name
      );
      report.migrationsMarkedApplied.push({
        name: spec.name,
        ok: resolved.status === 0,
        output: sanitizeProcessOutput(`${resolved.stdout || ""}\n${resolved.stderr || ""}`),
      });
    }

    const deploy = migrateDeploy(loaded.GROWTH_DOGFOOD_DATABASE_URL, loaded.GROWTH_DOGFOOD_DIRECT_URL);
    report.migrationsApplied = deploy.status === 0;
    report.migrateDeployOutput = sanitizeProcessOutput(`${deploy.stdout || ""}\n${deploy.stderr || ""}`);
    if (deploy.status !== 0) {
      report.ok = false;
      report.token = "STAGING_BOOTSTRAP_FAILED";
      report.error = "migrate_deploy_failed";
      console.log(JSON.stringify(report, null, 2));
      process.exit(2);
    }

    const after = migrateStatus(loaded.GROWTH_DOGFOOD_DATABASE_URL, loaded.GROWTH_DOGFOOD_DIRECT_URL);
    report.migrationStatusAfter = sanitizeProcessOutput(after.stdout || after.stderr);

    const existing = await prisma.workspace.findUnique({
      where: { clerkUserId: SYNTHETIC_DOGFOOD_CLERK_USER_ID },
    });
    const workspace =
      existing ||
      (await prisma.workspace.create({
        data: {
          clerkUserId: SYNTHETIC_DOGFOOD_CLERK_USER_ID,
          email: SYNTHETIC_DOGFOOD_EMAIL,
        },
      }));
    report.workspace = {
      id: workspace.id,
      created: !existing,
      clerkUserId: SYNTHETIC_DOGFOOD_CLERK_USER_ID,
      email: SYNTHETIC_DOGFOOD_EMAIL,
    };
    report.GROWTH_DOGFOOD_WORKSPACE_ID = workspace.id;
    report.workspaceIdRedacted = redactId(workspace.id);
    report.token = "READY_FOR_DOGFOOD_CONFIRMATION";
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, token: "STAGING_BOOTSTRAP_FAILED", error: String(err?.message || err).slice(0, 300) }, null, 2));
  process.exit(1);
});
