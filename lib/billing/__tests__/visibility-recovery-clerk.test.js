import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recordClerkVisibilityRecoveryHold } from "../visibility-recovery-clerk.js";

const input = {
  operationId: "operation-1", workspaceId: "workspace-1",
  evidence: ["incident-1"], reason: "Needs manual investigation",
  actor: { id: "attacker" }, reviewerId: "attacker",
};
const policy = {
  actorId: "clerk-admin", enabled: true,
  workspaceIds: ["workspace-1"],
  permissions: ["visibility.recovery.hold"],
};

describe("Clerk recovery HOLD adapter", () => {
  it("requires trusted policy storage and server auth resolver", async () => {
    await assert.rejects(recordClerkVisibilityRecoveryHold({}, input, {
      getAuth: async () => ({ userId: "clerk-admin" }),
    }), /grant database required/);
    await assert.rejects(recordClerkVisibilityRecoveryHold({}, input, {
      loadPolicy: async () => policy, getAuth: null,
    }), /auth resolver/);
  });
  it("rejects unauthenticated requests without querying policy or writing", async () => {
    let reads = 0;
    let writes = 0;
    await assert.rejects(recordClerkVisibilityRecoveryHold({}, input, {
      getAuth: async () => ({ userId: null }),
      loadPolicy: async () => { reads++; return policy; },
      record: async () => { writes++; },
    }), /authentication required/);
    assert.equal(reads, 0);
    assert.equal(writes, 0);
  });
  it("uses verified Clerk userId instead of request-supplied reviewerId", async () => {
    let recorded;
    await recordClerkVisibilityRecoveryHold({}, input, {
      getAuth: async () => ({ userId: "clerk-admin" }),
      loadPolicy: async (actorId) => {
        assert.equal(actorId, "clerk-admin");
        return policy;
      },
      record: async (_db, data) => {
        recorded = data;
        return { status: "recorded" };
      },
    });
    assert.equal(recorded.reviewerId, "clerk-admin");
  });
  it("denies non-admin, revoked, and cross-workspace permissions", async () => {
    let writes = 0;
    for (const [userId, currentPolicy, workspaceId] of [
      ["clerk-user", null, "workspace-1"],
      ["clerk-admin", { ...policy, enabled: false }, "workspace-1"],
      ["clerk-admin", policy, "workspace-2"],
    ]) {
      await assert.rejects(recordClerkVisibilityRecoveryHold({}, {
        ...input, workspaceId,
      }, {
        getAuth: async () => ({ userId }),
        loadPolicy: async () => currentPolicy,
        record: async () => { writes++; },
      }), /denied/);
    }
    assert.equal(writes, 0);
  });
  it("fails closed when trusted policy lookup throws", async () => {
    let writes = 0;
    await assert.rejects(recordClerkVisibilityRecoveryHold({}, input, {
      getAuth: async () => ({ userId: "clerk-admin" }),
      loadPolicy: async () => { throw new Error("policy database offline"); },
      record: async () => { writes++; },
    }), /offline/);
    assert.equal(writes, 0);
  });
});
