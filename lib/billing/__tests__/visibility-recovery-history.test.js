import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listVisibilityRecoveryReviews } from "../visibility-recovery-history.js";

describe("visibility recovery review history", () => {
  it("queries with operation and workspace constraints and no writes", async () => {
    const queries = [];
    const prisma = { visibilityRecoveryReview: {
      async findMany(query) { queries.push(query); return []; },
    } };
    assert.deepEqual(await listVisibilityRecoveryReviews(prisma, {
      operationId: "op_1", workspaceId: "ws_1", take: 10,
    }), []);
    assert.deepEqual(queries[0].where, {
      operationId: "op_1", workspaceId: "ws_1", operation: { workspaceId: "ws_1" },
    });
    assert.equal(queries[0].take, 10);
    assert.deepEqual(Object.keys(prisma.visibilityRecoveryReview), ["findMany"]);
  });

  it("rejects unscoped and oversized queries", async () => {
    const prisma = { visibilityRecoveryReview: { findMany: async () => [] } };
    await assert.rejects(listVisibilityRecoveryReviews(prisma, {
      operationId: "op_1", workspaceId: "",
    }), TypeError);
    await assert.rejects(listVisibilityRecoveryReviews(prisma, {
      operationId: "op_1", workspaceId: "ws_1", take: 101,
    }), TypeError);
  });
});
