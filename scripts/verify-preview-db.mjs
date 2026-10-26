// Read-only, operator-invoked check for an isolated Preview/Staging environment.
// Run locally with Preview-scoped environment variables; never expose as HTTP route.
import { PrismaClient } from "@prisma/client";

function parseDatabaseUrl(name) {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is missing`);
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error(`${name} is not a PostgreSQL URL`);
  }
  return {
    host: url.hostname.toLowerCase(),
    database: decodeURIComponent(url.pathname.slice(1)),
  };
}

const normalizeHost = host => host.replace("-pooler.", ".");
const runtime = parseDatabaseUrl("DATABASE_URL");
const direct = parseDatabaseUrl("DIRECT_URL");
const expectedHost = process.env.EXPECTED_STAGING_DB_HOST?.trim().toLowerCase();
if (!expectedHost || !/^[a-z0-9.-]+$/.test(expectedHost)) {
  throw new Error("EXPECTED_STAGING_DB_HOST must be the Neon test endpoint hostname (no URL or credentials)");
}
if (runtime.database !== direct.database ||
    normalizeHost(runtime.host) !== normalizeHost(direct.host)) {
  throw new Error("BLOCKED: runtime and migration URLs target different database endpoints");
}
if (normalizeHost(runtime.host) !== normalizeHost(expectedHost)) {
  throw new Error("BLOCKED: database endpoint does not match the independently verified staging host");
}
if (process.env.VERCEL_ENV === "production") {
  throw new Error("BLOCKED: this check must not run in Vercel Production");
}

const prisma = new PrismaClient();
try {
  const rows = await prisma.$queryRaw`SELECT current_database() AS database_name, current_user AS database_role`;
  if (rows.length !== 1 || rows[0].database_name !== runtime.database) {
    throw new Error("BLOCKED: database identity differs from the configured database");
  }
  // Intentionally avoid logging hostnames, URLs, credentials, or user IDs.
  console.log("PASS: connected database matches the independently supplied staging endpoint");
  console.log("PASS: runtime and direct URLs reference the same database endpoint");
  console.log("Database:", rows[0].database_name);
  console.log("Role:", rows[0].database_role);
} finally {
  await prisma.$disconnect();
}
