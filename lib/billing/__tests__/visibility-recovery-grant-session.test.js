import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changeSessionRecoveryAdminGrant } from "../visibility-recovery-grant-session.js";

const request = {
  operatorId: "spoofed", role: "superadmin",
  targetActorId: "reviewer", action: "grant",
  workspaceIds: ["ws1"], permissions: ["visibility.recovery.hold"],
  reason: "approved",
};
describe("recovery grant verified operator boundary", () => {
  it("requires both verified identity and independent authorization", async () => {
    await assert.rejects(changeSessionRecoveryAdminGrant({}, request),
      /Verified operator session/);
    await assert.rejects(changeSessionRecoveryAdminGrant({}, request, {
      resolveVerifiedOperator: async () => ({ id: "operator" }),
    }), /Verified operator session/);
  });
  it("rejects unauthenticated operator without mutation", async () => {
    let called = false;
    await assert.rejects(changeSessionRecoveryAdminGrant({}, request, {
      resolveVerifiedOperator: async () => ({ id: "" }),
      authorizeOperator: async () => true,
      change: async () => { called = true; },
    }), /authentication required/);
    assert.equal(called, false);
  });
  it("ignores spoofed caller identity and role", async () => {
    let forwarded;
    const result = await changeSessionRecoveryAdminGrant({}, request, {
      resolveVerifiedOperator: async () => ({ id: "verified-operator" }),
      authorizeOperator: async ({ operator }) => operator.id === "verified-operator",
      change: async (_db, input, opts) => {
        forwarded = input;
        assert.equal(await opts.authorizeOperator({
          operatorId: input.operatorId, action: input.action,
          targetActorId: input.targetActorId,
        }), true);
        assert.equal(await opts.authorizeOperator({
          operatorId: "spoofed", action: input.action,
          targetActorId: input.targetActorId,
        }), false);
        return { status: "granted" };
      },
    });
    assert.equal(result.status, "granted");
    assert.equal(forwarded.operatorId, "verified-operator");
    assert.equal("role" in forwarded, false);
  });
  it("denies when policy lookup returns truthy non-boolean or throws", async () => {
    const opts = {
      resolveVerifiedOperator: async () => ({ id: "operator" }),
    };
    await assert.rejects(changeSessionRecoveryAdminGrant({}, request, {
      ...opts, authorizeOperator: async () => "true",
    }), /authorization denied/);
    await assert.rejects(changeSessionRecoveryAdminGrant({}, request, {
      ...opts, authorizeOperator: async () => { throw new Error("policy offline"); },
    }), /policy offline/);
  });
});
