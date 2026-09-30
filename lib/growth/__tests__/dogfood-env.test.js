import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertStagingTarget, parsePgIdentity } from "../dogfood-env.js";
import { loadDogfoodDatabaseUrl } from "../dogfood.js";

describe("staging dogfood env identity", () => {
  it("redacts neon hosts and does not treat missing env as staging", () => {
    const id = parsePgIdentity("postgresql://u:secret@ep-hello-world.ap-southeast-1.aws.neon.tech/neondb");
    assert.equal(id.database, "neondb");
    assert.equal(/secret/.test(id.redactedHost), false);
    assert.match(id.redactedHost, /neon\.tech$/);
  });

  it("detects pooled vs direct of the same neon endpoint as the same target", () => {
    const pooled = parsePgIdentity(
      "postgresql://u:p@ep-dogfood-abc-pooler.ap-southeast-1.aws.neon.tech/neondb"
    );
    const direct = parsePgIdentity(
      "postgresql://u:p@ep-dogfood-abc.ap-southeast-1.aws.neon.tech/neondb"
    );
    assert.equal(pooled.neonEndpoint, direct.neonEndpoint);
    assert.equal(pooled.pooled, true);
    assert.equal(direct.pooled, false);
  });

  it("returns STAGING_DATABASE_COLLISION when dogfood and production share host+database", () => {
    const url = "postgresql://u:p@ep-same.ap-southeast-1.aws.neon.tech/neondb";
    const check = assertStagingTarget({
      GROWTH_DOGFOOD_ENV: "staging",
      GROWTH_DOGFOOD_DATABASE_URL: url,
      GROWTH_DOGFOOD_DIRECT_URL: "",
      productionDatabaseUrl: url,
      productionDirectUrl: "",
    });
    assert.equal(check.ok, false);
    assert.equal(check.token, "STAGING_DATABASE_COLLISION");
    assert.equal(/u:p|postgresql/i.test(JSON.stringify(check)), false);
  });

  it("does not fall back to production DATABASE_URL for dogfood URL", () => {
    const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), "aso-dogfood-"));
    const url = loadDogfoodDatabaseUrl({ DATABASE_URL: "postgresql://u:p@127.0.0.1/prod" }, emptyCwd);
    assert.equal(url, "");
  });
});
