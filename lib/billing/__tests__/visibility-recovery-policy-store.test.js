import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPrismaRecoveryAdminPolicyLoader } from "../visibility-recovery-policy-store.js";

describe("recovery admin policy storage", () => {
  it("requires a trusted Prisma model", () => {
    assert.throws(() => createPrismaRecoveryAdminPolicyLoader({}), /database required/);
  });
  it("reads only server-stored grant fields", async () => {
    let query;
    const loader = createPrismaRecoveryAdminPolicyLoader({
      visibilityRecoveryAdminGrant: {
        findUnique: async (args) => {
          query = args;
          return { actorId: "admin-1", enabled: true,
            permissions: ["visibility.recovery.hold"], workspaceIds: ["ws1"] };
        },
      },
    });
    const policy = await loader("admin-1");
    assert.equal(policy.actorId, "admin-1");
    assert.deepEqual(query.where, { actorId: "admin-1" });
    assert.deepEqual(Object.keys(query.select).sort(),
      ["actorId", "enabled", "permissions", "workspaceIds"].sort());
  });
  it("denies blank and missing grants without provisioning", async () => {
    let queries = 0;
    const loader = createPrismaRecoveryAdminPolicyLoader({
      visibilityRecoveryAdminGrant: {
        findUnique: async () => { queries++; return null; },
      },
    });
    assert.equal(await loader(" "), null);
    assert.equal(queries, 0);
    assert.equal(await loader("unknown"), null);
    assert.equal(queries, 1);
  });
  it("propagates database failures rather than granting access", async () => {
    const loader = createPrismaRecoveryAdminPolicyLoader({
      visibilityRecoveryAdminGrant: {
        findUnique: async () => { throw new Error("DB unavailable"); },
      },
    });
    await assert.rejects(loader("admin-1"), /DB unavailable/);
  });
});
