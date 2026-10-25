import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listStaleVisibilityReservations } from "../visibility-recovery.js";

describe("visibility reservation recovery inspection", () => {
  it("lists only old reserved operations without mutating accounting", async () => {
    const calls = [];
    const prisma = {
      visibilityUsageOperation: {
        async findMany(args) { calls.push(args); return [{ id: "op_1", reservedAiTests: 10 }]; },
      },
    };
    const olderThan = new Date("2026-10-01T00:00:00.000Z");
    const result = await listStaleVisibilityReservations(prisma, { olderThan, take: 25 });
    assert.equal(result[0].id, "op_1");
    assert.deepEqual(calls[0].where, { status: "reserved", createdAt: { lt: olderThan } });
    assert.equal(calls[0].take, 25);
    assert.deepEqual(Object.keys(prisma.visibilityUsageOperation), ["findMany"]);
  });

  it("rejects invalid cutoffs and oversized batches", async () => {
    const prisma = { visibilityUsageOperation: { findMany: async () => [] } };
    await assert.rejects(listStaleVisibilityReservations(prisma, { take: 501 }), TypeError);
    await assert.rejects(listStaleVisibilityReservations(prisma, { olderThan: new Date("invalid") }), TypeError);
    await assert.rejects(listStaleVisibilityReservations(prisma, { take: 0 }), TypeError);
  });
});
