import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareVisibilityRecoveryDecision } from "../visibility-recovery-decision.js";

const base = {
  operationId: "op_1", workspaceId: "ws_1", reviewerId: "admin_1",
  decision: "hold", evidence: ["incident:INC-1"], reason: "Awaiting provider reconciliation",
};

describe("visibility recovery review decision", () => {
  it("creates a non-executable, immutable hold review record", () => {
    const result = prepareVisibilityRecoveryDecision(base);
    assert.equal(result.executionAllowed, false);
    assert.equal(result.decision, "hold");
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.evidence));
  });

  it("rejects release and settlement until evidence verification is implemented", () => {
    for (const decision of ["release", "settle"]) {
      assert.throws(() => prepareVisibilityRecoveryDecision({ ...base, decision }), /not enabled/);
    }
  });

  it("rejects missing reviewer, evidence and unsupported actions", () => {
    assert.throws(() => prepareVisibilityRecoveryDecision({ ...base, reviewerId: "" }), TypeError);
    assert.throws(() => prepareVisibilityRecoveryDecision({ ...base, evidence: [] }), TypeError);
    assert.throws(() => prepareVisibilityRecoveryDecision({ ...base, decision: "refund" }), TypeError);
  });
});
