import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createVisibilityUsageSession } from "../visibility-usage-session.js";

describe("visibility usage session adapter", () => {
  const make = (overrides = {}) => {
    const calls = [];
    const session = createVisibilityUsageSession({
      prisma: {}, workspaceId: "ws_1", operationId: "op_1",
      reserve: async (_, args) => { calls.push(["reserve", args]); return { status: "reserved", reserved: args.aiTests }; },
      settle: async (_, args) => { calls.push(["settle", args]); return { status: "already_committed" }; },
      release: async (_, args) => { calls.push(["release", args]); return { status: "released" }; },
      ...overrides,
    });
    return { session, calls };
  };

  it("uses the same operation ID for reserve, commit and release", async () => {
    const { session, calls } = make();
    assert.deepEqual(await session.reserve({ aiTests: 10, limit: 20 }), { ok: true, reserved: 10 });
    assert.equal(await session.commit(7), true);
    assert.equal(await session.release(), true);
    assert.deepEqual(calls.map(([name, args]) => [name, args.operationId, args.workspaceId]), [
      ["reserve", "op_1", "ws_1"], ["settle", "op_1", "ws_1"], ["release", "op_1", "ws_1"],
    ]);
  });

  it("treats insufficient allowance as a non-throwing denial", async () => {
    const { session } = make({ reserve: async () => ({ status: "insufficient_allowance" }) });
    assert.deepEqual(await session.reserve({ aiTests: 10 }), { ok: false, reason: "insufficient_allowance" });
  });

  it("rejects a previously finalized operation rather than rerunning providers", async () => {
    const { session } = make({ reserve: async () => ({ status: "committed", reserved: 10 }) });
    await assert.rejects(session.reserve({ aiTests: 10 }), /reservation conflict/);
  });

  it("accepts idempotent settlement but rejects invalid settlement statuses", async () => {
    assert.equal(await make().session.commit(4), true);
    const { session } = make({ settle: async () => ({ status: "amount_conflict" }) });
    await assert.rejects(session.commit(4), /settlement rejected/);
  });

  it("does not treat missing releases as success", async () => {
    const { session } = make({ release: async () => ({ status: "not_found" }) });
    await assert.rejects(session.release(), /release rejected/);
  });
});
