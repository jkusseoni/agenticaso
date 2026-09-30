import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import {
  SYNTHETIC_DOGFOOD_CLERK_USER_ID,
  assertStagingTarget,
  loadDogfoodEnv,
} from "../lib/growth/dogfood-env.js";
import { redactId, writesAllowed } from "../lib/growth/dogfood.js";

function sanitize(text) {
  return String(text || "")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted-db-url]")
    .replace(/npg_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/\bep-[a-z0-9-]+\.[a-z0-9.-]*neon\.tech/gi, "[redacted-host]")
    .slice(0, 2000);
}

const loaded = loadDogfoodEnv();
const identity = assertStagingTarget(loaded);
const confirm = loaded.GROWTH_DOGFOOD_CONFIRM === "YES";
const classified = identity.ok ? identity.classified.classification : null;
const writeGate = writesAllowed(classified || "unknown", {
  GROWTH_DOGFOOD_CONFIRM: loaded.GROWTH_DOGFOOD_CONFIRM,
});

const out = {
  GROWTH_DOGFOOD_ENV: loaded.GROWTH_DOGFOOD_ENV || null,
  envIsStaging: String(loaded.GROWTH_DOGFOOD_ENV || "").toLowerCase() === "staging",
  dogfoodUrlSet: Boolean(loaded.GROWTH_DOGFOOD_DATABASE_URL),
  confirmIsYes: confirm,
  workspaceIdSet: Boolean(loaded.GROWTH_DOGFOOD_WORKSPACE_ID),
  workspaceIdRedacted: loaded.GROWTH_DOGFOOD_WORKSPACE_ID ? redactId(loaded.GROWTH_DOGFOOD_WORKSPACE_ID) : null,
  identityOk: identity.ok,
  identityToken: identity.token || null,
  identityError: identity.error || null,
  staging: identity.ok
    ? {
        host: identity.staging.redactedHost,
        database: identity.staging.database,
        classification: identity.classified.classification,
      }
    : identity.staging || null,
  production: identity.production
    ? { host: identity.production.redactedHost, database: identity.production.database }
    : null,
  collision: identity.token === "STAGING_DATABASE_COLLISION",
  writeGate,
};

if (!identity.ok || !confirm || !writeGate.ok || !loaded.GROWTH_DOGFOOD_WORKSPACE_ID) {
  console.log(JSON.stringify({ ...out, ok: false, token: "DOGFOOD_SEED_FAILED" }, null, 2));
  process.exit(2);
}

const env = { ...process.env };
delete env.DATABASE_URL;
delete env.DIRECT_URL;
env.DATABASE_URL = loaded.GROWTH_DOGFOOD_DATABASE_URL;
env.DIRECT_URL = loaded.GROWTH_DOGFOOD_DIRECT_URL || loaded.GROWTH_DOGFOOD_DATABASE_URL;
const status = spawnSync("npx", ["prisma", "migrate", "status"], { env, encoding: "utf8", shell: true });
const statusText = sanitize(`${status.stdout || ""}\n${status.stderr || ""}`);
const upToDate = /Database schema is up to date/i.test(statusText);

const prisma = new PrismaClient({ datasources: { db: { url: loaded.GROWTH_DOGFOOD_DATABASE_URL } } });
try {
  const workspace = await prisma.workspace.findUnique({
    where: { id: loaded.GROWTH_DOGFOOD_WORKSPACE_ID },
    select: { id: true, clerkUserId: true, email: true },
  });
  out.migrationStatus = statusText;
  out.schemaUpToDate = upToDate;
  out.workspace = workspace
    ? {
        idRedacted: redactId(workspace.id),
        clerkUserId: workspace.clerkUserId,
        email: workspace.email,
        synthetic: workspace.clerkUserId === SYNTHETIC_DOGFOOD_CLERK_USER_ID,
      }
    : null;
  const ok = Boolean(upToDate && workspace && workspace.clerkUserId === SYNTHETIC_DOGFOOD_CLERK_USER_ID);
  console.log(JSON.stringify({ ...out, ok }, null, 2));
  process.exit(ok ? 0 : 2);
} finally {
  await prisma.$disconnect();
}
