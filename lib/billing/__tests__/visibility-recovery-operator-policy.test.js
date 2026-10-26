import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRecoveryGrantOperatorAuthorizer } from "../visibility-recovery-operator-policy.js";

describe("independent recovery grant operator policy", () => {
  it("requires trusted explicit configuration and rejects malformed identities", () => {
    assert.throws(() => createRecoveryGrantOperatorAuthorizer(), /configuration required/);
    assert.throws(() => createRecoveryGrantOperatorAuthorizer({ operatorIds: [" "] }), /configuration required/);
    assert.throws(() => createRecoveryGrantOperatorAuthorizer({ operatorIds: ["op", "op"] }), /configuration required/);
  });
  it("defaults to deny with empty operator list", async () => {
    const authorize = createRecoveryGrantOperatorAuthorizer({ operatorIds: [] });
    assert.equal(await authorize({
      operator: { id: "anyone" }, action: "grant", targetActorId: "reviewer",
    }), false);
  });
  it("permits only configured verified operator and blocks self-grant", async () => {
    const authorize = createRecoveryGrantOperatorAuthorizer({ operatorIds: ["trusted"] });
    const request = { action: "grant", targetActorId: "reviewer" };
    assert.equal(await authorize({ operator: { id: "trusted" }, ...request }), true);
    assert.equal(await authorize({ operator: { id: "other", role: "admin" }, ...request }), false);
    assert.equal(await authorize({ operator: { id: "trusted" }, action: "grant", targetActorId: "trusted" }), false);
    assert.equal(await authorize({ operator: { id: "trusted" }, action: "settle", targetActorId: "reviewer" }), false);
    assert.equal(await authorize({ operator: { id: "trusted" }, action: "revoke", targetActorId: "reviewer" }), true);
  });
});
