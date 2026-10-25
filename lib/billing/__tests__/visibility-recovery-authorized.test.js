import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recordAuthorizedVisibilityRecoveryHold } from "../visibility-recovery-authorized.js";

const input = {
  actor: { id: "verified-admin" }, operationId: "op1", workspaceId: "ws1",
  evidence: ["incident:1"], reason: "Manual review",
};
describe("visibility recovery authorization boundary", () => {
  it("denies missing verified actor or authorizer", async () => {
    await assert.rejects(recordAuthorizedVisibilityRecoveryHold({}, input), /authorization/);
    await assert.rejects(recordAuthorizedVisibilityRecoveryHold({}, { ...input, actor: null }, {
      authorize: async () => true,
    }), /authorization/);
  });
  it("denies false, undefined and non-boolean authorizations without writing", async () => {
    let writes = 0;
    for (const result of [false, undefined, "true"]) {
      await assert.rejects(recordAuthorizedVisibilityRecoveryHold({}, input, {
        authorize: async () => result, record: async () => { writes++; },
      }), /denied/);
    }
    assert.equal(writes, 0);
  });
  it("uses verified actor identity rather than caller reviewerId", async () => {
    let saved;
    const result = await recordAuthorizedVisibilityRecoveryHold({}, {
      ...input, reviewerId: "spoofed",
    }, {
      authorize: async ({ actor, workspaceId, permission }) =>
        actor.id === "verified-admin" && workspaceId === "ws1" &&
        permission === "visibility.recovery.hold",
      record: async (_prisma, payload) => {
        saved = payload;
        return { status: "recorded" };
      },
    });
    assert.equal(result.status, "recorded");
    assert.equal(saved.reviewerId, "verified-admin");
  });
  it("rejects cross-workspace permissions", async () => {
    await assert.rejects(recordAuthorizedVisibilityRecoveryHold({}, {
      ...input, workspaceId: "other-workspace",
    }, {
      authorize: async ({ workspaceId }) => workspaceId === "ws1",
      record: async () => { throw new Error("must not write"); },
    }), /denied/);
  });
});
