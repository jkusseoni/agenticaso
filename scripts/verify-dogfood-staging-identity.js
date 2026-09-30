import { assertStagingTarget, loadDogfoodEnv } from "../lib/growth/dogfood-env.js";

const loaded = loadDogfoodEnv();
const check = assertStagingTarget(loaded);
const out = {
  GROWTH_DOGFOOD_ENV: loaded.GROWTH_DOGFOOD_ENV || null,
  envIsStaging: String(loaded.GROWTH_DOGFOOD_ENV || "").trim().toLowerCase() === "staging",
  dogfoodUrlSet: Boolean(loaded.GROWTH_DOGFOOD_DATABASE_URL),
  dogfoodDirectSet: Boolean(loaded.GROWTH_DOGFOOD_DIRECT_URL),
  confirmIsYes: loaded.GROWTH_DOGFOOD_CONFIRM === "YES",
  workspaceIdPreSet: Boolean(loaded.GROWTH_DOGFOOD_WORKSPACE_ID),
  checkOk: check.ok,
  token: check.token || null,
  error: check.error || null,
  staging: check.ok
    ? {
        host: check.staging.redactedHost,
        database: check.staging.database,
        classification: check.classified.classification,
        reason: check.classified.reason,
        pooled: check.staging.pooled,
        directHost: check.stagingDirect.set ? check.stagingDirect.redactedHost : null,
        directDatabase: check.stagingDirect.set ? check.stagingDirect.database : null,
        directPooled: check.stagingDirect.set ? check.stagingDirect.pooled : null,
      }
    : check.staging || null,
  production: check.production
    ? { host: check.production.redactedHost, database: check.production.database }
    : null,
};
console.log(JSON.stringify(out, null, 2));
if (!check.ok) process.exit(2);
