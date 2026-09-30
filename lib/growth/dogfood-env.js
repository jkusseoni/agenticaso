/**
 * Staging dogfood env identity. Never logs credential values.
 */
import fs from "node:fs";
import path from "node:path";
import { classifyDatabaseUrl, redactHost } from "./dogfood.js";

function readEnvFileValue(filePath, key) {
  if (!fs.existsSync(filePath)) return "";
  const txt = fs.readFileSync(filePath, "utf8");
  const m = txt.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!m) return "";
  return m[1].trim().replace(/^['"]|['"]$/g, "");
}

export const SYNTHETIC_DOGFOOD_CLERK_USER_ID = "growth_dogfood_staging_synthetic";
export const SYNTHETIC_DOGFOOD_EMAIL = "growth-dogfood@staging.invalid";

export function parsePgIdentity(raw) {
  if (!raw) return { set: false, host: null, database: null, neonEndpoint: null, pooled: false, redactedHost: null };
  try {
    const u = new URL(String(raw).replace(/^postgresql:/i, "http:"));
    const host = u.hostname || "";
    const database = (u.pathname || "").replace(/^\//, "").split("?")[0] || null;
    const pooled = /-pooler(\.|$)/i.test(host);
    const neonEndpoint = host.replace(/-pooler(?=\.)/i, "").toLowerCase();
    return {
      set: true,
      host,
      redactedHost: redactHost(host),
      database,
      neonEndpoint,
      pooled,
    };
  } catch {
    return { set: true, parseError: true, host: null, database: null, neonEndpoint: null, pooled: false, redactedHost: null };
  }
}

export function loadDogfoodEnv(cwd = process.cwd(), env = process.env) {
  const fileLocal = path.join(cwd, ".env.local");
  const fileEnv = path.join(cwd, ".env");
  const pick = (key) =>
    String(env[key] || readEnvFileValue(fileLocal, key) || readEnvFileValue(fileEnv, key) || "").trim();

  const productionUrl = env.DATABASE_URL
    ? String(env.DATABASE_URL).trim()
    : readEnvFileValue(fileLocal, "DATABASE_URL") || readEnvFileValue(fileEnv, "DATABASE_URL");
  const productionDirect = env.DIRECT_URL
    ? String(env.DIRECT_URL).trim()
    : readEnvFileValue(fileLocal, "DIRECT_URL") || readEnvFileValue(fileEnv, "DIRECT_URL");

  return {
    GROWTH_DOGFOOD_ENV: pick("GROWTH_DOGFOOD_ENV"),
    GROWTH_DOGFOOD_DATABASE_URL: pick("GROWTH_DOGFOOD_DATABASE_URL"),
    GROWTH_DOGFOOD_DIRECT_URL: pick("GROWTH_DOGFOOD_DIRECT_URL"),
    GROWTH_DOGFOOD_WORKSPACE_ID: pick("GROWTH_DOGFOOD_WORKSPACE_ID"),
    GROWTH_DOGFOOD_CONFIRM: pick("GROWTH_DOGFOOD_CONFIRM"),
    GROWTH_DOGFOOD_URLS: pick("GROWTH_DOGFOOD_URLS"),
    productionDatabaseUrl: productionUrl,
    productionDirectUrl: productionDirect,
  };
}

function sameTarget(a, b) {
  return (
    a.set &&
    b.set &&
    !a.parseError &&
    !b.parseError &&
    Boolean(a.database) &&
    Boolean(b.database) &&
    a.database === b.database &&
    a.neonEndpoint === b.neonEndpoint
  );
}

export function assertStagingTarget(loaded) {
  const envName = String(loaded.GROWTH_DOGFOOD_ENV || "").trim().toLowerCase();
  if (envName !== "staging") {
    return {
      ok: false,
      token: "STAGING_BOOTSTRAP_FAILED",
      error: "GROWTH_DOGFOOD_ENV_must_be_staging",
      GROWTH_DOGFOOD_ENV: loaded.GROWTH_DOGFOOD_ENV || null,
    };
  }
  if (!loaded.GROWTH_DOGFOOD_DATABASE_URL) {
    return { ok: false, token: "STAGING_BOOTSTRAP_FAILED", error: "GROWTH_DOGFOOD_DATABASE_URL_missing" };
  }
  const staging = parsePgIdentity(loaded.GROWTH_DOGFOOD_DATABASE_URL);
  const production = parsePgIdentity(loaded.productionDatabaseUrl);
  const stagingDirect = parsePgIdentity(loaded.GROWTH_DOGFOOD_DIRECT_URL);
  const productionDirect = parsePgIdentity(loaded.productionDirectUrl);
  const classified = classifyDatabaseUrl(loaded.GROWTH_DOGFOOD_DATABASE_URL, {
    GROWTH_DOGFOOD_ENV: loaded.GROWTH_DOGFOOD_ENV,
  });

  const collision =
    sameTarget(staging, production) ||
    (stagingDirect.set && sameTarget(stagingDirect, production)) ||
    (productionDirect.set && sameTarget(staging, productionDirect)) ||
    (stagingDirect.set && productionDirect.set && sameTarget(stagingDirect, productionDirect));

  if (collision) {
    return {
      ok: false,
      token: "STAGING_DATABASE_COLLISION",
      error: "staging_target_matches_production",
      staging: {
        host: staging.redactedHost,
        database: staging.database,
        classification: classified.classification,
      },
      production: {
        host: production.redactedHost,
        database: production.database,
      },
    };
  }

  if (stagingDirect.set) {
    const sameStagingEnv =
      stagingDirect.database === staging.database && stagingDirect.neonEndpoint === staging.neonEndpoint;
    if (!sameStagingEnv) {
      return {
        ok: false,
        token: "STAGING_BOOTSTRAP_FAILED",
        error: "GROWTH_DOGFOOD_DIRECT_URL_not_same_staging_database",
        staging: { host: staging.redactedHost, database: staging.database },
        direct: { host: stagingDirect.redactedHost, database: stagingDirect.database },
      };
    }
  }

  return {
    ok: true,
    staging,
    stagingDirect,
    production,
    classified,
  };
}
