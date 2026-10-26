import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recordDatabaseAuthorizedRecoveryHold } from "../visibility-recovery-admin.js";

const input = {
  operationId: "op1", workspaceId: "ws1",
  reason: "Manual investigation required", evidence: ["incident-123"],
  reviewerId: "spoofed",
};
const grant = {
  actorId: "clerk-admin", enabled: true,
  permissions: ["visibility.recovery.hold"], workspaceIds: ["ws1"],
};

describe("database-authorized recovery HOLD composition", () => {
  function db(policy) {
    return {
      visibilityRecoveryAdminGrant: {
        findUnique: async ({ where }) => where.actorId === "clerk-admin" ? policy : null,
      },
    };
  }
  it("accepts server-verified scoped admin and ignores spoofed reviewer", async () => {
    let written;
    const result = await recordDatabaseAuthorizedRecoveryHold(db(grant), input, {
      getAuth: async () => ({ userId: "clerk-admin" }),
      record: async (_prisma, payload) => {
        written = payload;
        return { ok: true };
      },
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(written.reviewerId, "clerk-admin");
  });
  it("denies absent, disabled, cross-workspace and missing permissions", async () => {
    for (const [policy, workspaceId] of [
      [null, "ws1"],
      [{ ...grant, enabled: false }, "ws1"],
      [grant, "ws2"],
      [{ ...grant, permissions: [] }, "ws1"],
    ]) {
      let writes = 0;
      await assert.rejects(recordDatabaseAuthorizedRecoveryHold(db(policy), {
        ...input, workspaceId,
      }, {
        getAuth: async () => ({ userId: "clerk-admin" }),
        record: async () => { writes++; },
      }), /denied/);
      assert.equal(writes, 0);
    }
  });
  it("rejects anonymous sessions and missing Prisma grant model", async () => {
    await assert.rejects(recordDatabaseAuthorizedRecoveryHold(db(grant), input, {
      getAuth: async () => ({ userId: null }),
      record: async () => { throw new Error("must not write"); },
    }), /authentication required/);
    await assert.rejects(recordDatabaseAuthorizedRecoveryHold({}, input, {
      getAuth: async () => ({ userId: "clerk-admin" }),
    }), /database required/);
  });
});
