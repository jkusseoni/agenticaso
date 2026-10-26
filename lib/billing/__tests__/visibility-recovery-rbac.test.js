import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRecoveryAdminAuthorizer, isRecoveryAdminAuthorized,
} from "../visibility-recovery-rbac.js";

const policy = {
  actorId: "admin-1", enabled: true,
  workspaceIds: ["workspace-1"],
  permissions: ["visibility.recovery.hold"],
};

describe("recovery admin scoped RBAC", () => {
  it("requires enabled matching actor, scope and explicit permission", () => {
    const request = {
      actorId: "admin-1", workspaceId: "workspace-1",
      permission: "visibility.recovery.hold",
    };
    assert.equal(isRecoveryAdminAuthorized(policy, request), true);
    assert.equal(isRecoveryAdminAuthorized(null, request), false);
    assert.equal(isRecoveryAdminAuthorized({ ...policy, enabled: false }, request), false);
    assert.equal(isRecoveryAdminAuthorized(policy, { ...request, actorId: "attacker" }), false);
    assert.equal(isRecoveryAdminAuthorized(policy, { ...request, workspaceId: "workspace-2" }), false);
    assert.equal(isRecoveryAdminAuthorized(policy, { ...request, permission: "visibility.recovery.read" }), false);
    assert.equal(isRecoveryAdminAuthorized(policy, { ...request, permission: "billing.admin" }), false);
  });
  it("denies malformed scopes and permissions", () => {
    const request = {
      actorId: "admin-1", workspaceId: "workspace-1",
      permission: "visibility.recovery.hold",
    };
    assert.equal(isRecoveryAdminAuthorized({ ...policy, workspaceIds: "*" }, request), false);
    assert.equal(isRecoveryAdminAuthorized({ ...policy, permissions: "*" }, request), false);
    assert.equal(isRecoveryAdminAuthorized({ ...policy, enabled: "true" }, request), false);
  });
  it("reads current trusted policy for each authorization call", async () => {
    let current = policy;
    let calls = 0;
    const authorize = createRecoveryAdminAuthorizer({
      loadPolicy: async () => { calls++; return current; },
    });
    const request = {
      actor: { id: "admin-1" }, workspaceId: "workspace-1",
      permission: "visibility.recovery.hold",
    };
    assert.equal(await authorize(request), true);
    current = { ...policy, enabled: false };
    assert.equal(await authorize(request), false);
    assert.equal(calls, 2);
  });
  it("rejects missing loader and propagates policy store failure", async () => {
    assert.throws(() => createRecoveryAdminAuthorizer(), /loader/);
    const authorize = createRecoveryAdminAuthorizer({
      loadPolicy: async () => { throw new Error("policy store unavailable"); },
    });
    await assert.rejects(authorize({
      actor: { id: "admin-1" }, workspaceId: "workspace-1",
      permission: "visibility.recovery.hold",
    }), /unavailable/);
  });
});
