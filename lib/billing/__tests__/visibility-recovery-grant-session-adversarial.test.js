import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changeSessionRecoveryAdminGrant } from "../visibility-recovery-grant-session.js";

const input = {
  operatorId: "forged-operator",
  role: "superadmin",
  targetActorId: "reviewer-1",
  workspaceIds: ["workspace-1"],
  permissions: ["visibility.recovery.hold"],
  action: "grant",
  reason: "approved review",
};

describe("operator grant session boundary — adversarial tests", () => {
  it("fails before mutation when session identity is missing", async () => {
    let writes = 0;
    await assert.rejects(changeSessionRecoveryAdminGrant({}, input, {
      resolveVerifiedOperator: async () => ({ id: "" }),
      authorizeOperator: async () => true,
      change: async () => { writes++; },
    }), /authentication required/);
    assert.equal(writes, 0);
  });

  it("does not forward caller-supplied operator identity or role", async () => {
    let observed;
    await changeSessionRecoveryAdminGrant({}, input, {
      resolveVerifiedOperator: async () => ({ id: "trusted-operator" }),
      authorizeOperator: async () => true,
      change: async (_db, request, options) => {
        observed = request;
        assert.equal(await options.authorizeOperator({
          operatorId: request.operatorId,
          action: request.action,
          targetActorId: request.targetActorId,
        }), true);
      },
    });
    assert.equal(observed.operatorId, "trusted-operator");
    assert.equal(Object.hasOwn(observed, "role"), false);
  });

  it("rejects forged identity passed to the authorization callback", async () => {
    let policyCalls = 0;
    await changeSessionRecoveryAdminGrant({}, input, {
      resolveVerifiedOperator: async () => ({ id: "trusted-operator" }),
      authorizeOperator: async () => { policyCalls++; return true; },
      change: async (_db, _request, options) => {
        assert.equal(await options.authorizeOperator({
          operatorId: "forged-operator", action: "grant", targetActorId: "reviewer-1",
        }), false);
      },
    });
    assert.equal(policyCalls, 0);
  });

  it("requires literal true from the independent operator policy", async () => {
    for (const verdict of [false, "true", 1, null, undefined]) {
      await changeSessionRecoveryAdminGrant({}, input, {
        resolveVerifiedOperator: async () => ({ id: "trusted-operator" }),
        authorizeOperator: async () => verdict,
        change: async (_db, request, options) => {
          assert.equal(await options.authorizeOperator({
            operatorId: request.operatorId, action: request.action,
            targetActorId: request.targetActorId,
          }), false);
        },
      });
    }
  });

  it("propagates policy lookup failures without granting access", async () => {
    await assert.rejects(changeSessionRecoveryAdminGrant({}, input, {
      resolveVerifiedOperator: async () => ({ id: "trusted-operator" }),
      authorizeOperator: async () => { throw new Error("policy unavailable"); },
      change: async (_db, request, options) => options.authorizeOperator({
        operatorId: request.operatorId, action: request.action,
        targetActorId: request.targetActorId,
      }),
    }), /policy unavailable/);
  });
});
