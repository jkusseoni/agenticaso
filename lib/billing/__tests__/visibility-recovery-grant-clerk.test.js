import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changeClerkRecoveryAdminGrant } from "../visibility-recovery-grant-clerk.js";

const input = {
  operatorId: "spoofed", role: "owner", targetActorId: "reviewer",
  action: "grant", workspaceIds: ["ws1"],
  permissions: ["visibility.recovery.hold"], reason: "manual approval",
};
describe("Clerk recovery grant operator adapter", () => {
  it("requires an independent operator policy and valid auth resolver", async () => {
    await assert.rejects(changeClerkRecoveryAdminGrant({}, input, {
      getAuth: async () => ({ userId: "operator" }),
    }), /Independent recovery grant operator policy/);
    await assert.rejects(changeClerkRecoveryAdminGrant({}, input, {
      authorizeOperator: async () => true, getAuth: null,
    }), /Clerk server auth resolver/);
  });
  it("denies unauthenticated requests before checking authorization or writing", async () => {
    let checked = false;
    let written = false;
    await assert.rejects(changeClerkRecoveryAdminGrant({}, input, {
      getAuth: async () => ({ userId: null }),
      authorizeOperator: async () => { checked = true; return true; },
      change: async () => { written = true; },
    }), /authentication required/);
    assert.equal(checked, false);
    assert.equal(written, false);
  });
  it("uses Clerk userId and ignores forged operatorId or role", async () => {
    let forwarded;
    const result = await changeClerkRecoveryAdminGrant({}, input, {
      getAuth: async () => ({ userId: "clerk-operator" }),
      authorizeOperator: async ({ operator }) => operator.id === "clerk-operator",
      change: async (_prisma, request, { authorizeOperator }) => {
        forwarded = request;
        assert.equal(await authorizeOperator({
          operatorId: request.operatorId, action: request.action,
          targetActorId: request.targetActorId,
        }), true);
        return { status: "granted" };
      },
    });
    assert.equal(result.status, "granted");
    assert.equal(forwarded.operatorId, "clerk-operator");
    assert.equal("role" in forwarded, false);
  });
  it("fails closed for revoked, invalid and unavailable operator policies", async () => {
    for (const authorizeOperator of [
      async () => false,
      async () => "true",
    ]) {
      await assert.rejects(changeClerkRecoveryAdminGrant({}, input, {
        getAuth: async () => ({ userId: "clerk-operator" }),
        authorizeOperator,
      }), /authorization denied/);
    }
    await assert.rejects(changeClerkRecoveryAdminGrant({}, input, {
      getAuth: async () => ({ userId: "clerk-operator" }),
      authorizeOperator: async () => { throw new Error("policy unavailable"); },
    }), /policy unavailable/);
  });
});
