import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recordSessionVisibilityRecoveryHold } from "../visibility-recovery-session.js";

const input = {
  operationId: "op1", workspaceId: "ws1", evidence: ["incident:1"],
  reason: "Manual review", actor: { id: "attacker" }, reviewerId: "attacker",
};

describe("verified-session visibility recovery", () => {
  it("requires both server-side identity resolver and authorizer", async () => {
    await assert.rejects(recordSessionVisibilityRecoveryHold({}, input), /required/);
    await assert.rejects(recordSessionVisibilityRecoveryHold({}, input, {
      resolveVerifiedActor: async () => ({ id: "admin" }),
    }), /required/);
  });
  it("ignores spoofed request identity and records verified identity", async () => {
    let recorded;
    const result = await recordSessionVisibilityRecoveryHold({}, input, {
      resolveVerifiedActor: async () => ({ id: "verified-admin" }),
      authorize: async ({ actor, workspaceId, permission }) =>
        actor.id === "verified-admin" && workspaceId === "ws1" &&
        permission === "visibility.recovery.hold",
      record: async (_db, payload) => {
        recorded = payload;
        return { status: "recorded" };
      },
    });
    assert.equal(result.status, "recorded");
    assert.equal(recorded.reviewerId, "verified-admin");
  });
  it("fails closed when session resolver fails or has no user", async () => {
    let writes = 0;
    for (const resolveVerifiedActor of [
      async () => { throw new Error("session unavailable"); },
      async () => null,
    ]) {
      await assert.rejects(recordSessionVisibilityRecoveryHold({}, input, {
        resolveVerifiedActor,
        authorize: async () => true,
        record: async () => { writes++; },
      }));
    }
    assert.equal(writes, 0);
  });
  it("rejects unauthorized workspace before writing", async () => {
    let writes = 0;
    await assert.rejects(recordSessionVisibilityRecoveryHold({}, {
      ...input, workspaceId: "other",
    }, {
      resolveVerifiedActor: async () => ({ id: "verified-admin" }),
      authorize: async ({ workspaceId }) => workspaceId === "ws1",
      record: async () => { writes++; },
    }), /denied/);
    assert.equal(writes, 0);
  });
});
