import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changeRecoveryAdminGrant } from "../visibility-recovery-grant-admin.js";

describe("recovery admin grant mutation boundary", () => {
  it("denies all changes without a verified operator authorizer", async () => {
    await assert.rejects(changeRecoveryAdminGrant({}, {
      operatorId: "operator", targetActorId: "admin",
      action: "grant", permissions: ["visibility.recovery.hold"],
      workspaceIds: ["ws1"], reason: "approved",
    }), /authorization denied/);
  });
  it("rejects unsupported permission and empty grant scope", async () => {
    await assert.rejects(changeRecoveryAdminGrant({}, {
      operatorId: "operator", targetActorId: "admin",
      action: "grant", permissions: ["visibility.recovery.settle"],
      workspaceIds: ["ws1"], reason: "approved",
    }, { authorizeOperator: async () => true }), /Invalid recovery grant/);
  });
  it("does not write if operator authorization returns truthy non-boolean", async () => {
    await assert.rejects(changeRecoveryAdminGrant({}, {
      operatorId: "operator", targetActorId: "admin",
      action: "revoke", reason: "removed",
    }, { authorizeOperator: async () => "true" }), /authorization denied/);
  });
});
