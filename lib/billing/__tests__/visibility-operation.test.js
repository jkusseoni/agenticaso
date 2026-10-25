import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reserveVisibilityOperation, releaseVisibilityOperation } from "../visibility-reservation.js";
import { settleVisibilityOperation } from "../visibility-settlement.js";

describe("visibility operation argument safety", () => {
  const neverTouchDb = new Proxy({}, {
    get() { throw new Error("Invalid request must not access database"); },
  });
  it("rejects missing operation IDs before DB access", async () => {
    await assert.rejects(
      reserveVisibilityOperation(neverTouchDb, { operationId: "", workspaceId: "ws", aiTests: 1 }),
      TypeError,
    );
    await assert.rejects(
      releaseVisibilityOperation(neverTouchDb, { operationId: "", workspaceId: "ws" }),
      TypeError,
    );
    await assert.rejects(
      settleVisibilityOperation(neverTouchDb, { operationId: "", workspaceId: "ws", actualAiTests: 1 }),
      TypeError,
    );
  });
  it("rejects fractional and negative usage amounts", async () => {
    for (const amount of [-1, 1.5, NaN, Infinity]) {
      await assert.rejects(
        reserveVisibilityOperation(neverTouchDb, { operationId: "op", workspaceId: "ws", aiTests: amount }),
        TypeError,
      );
      await assert.rejects(
        settleVisibilityOperation(neverTouchDb, { operationId: "op", workspaceId: "ws", actualAiTests: amount }),
        TypeError,
      );
    }
  });
  it("rejects invalid period dates and limits", async () => {
    await assert.rejects(
      reserveVisibilityOperation(neverTouchDb, { operationId: "op", workspaceId: "ws", aiTests: 1, now: new Date(NaN) }),
      TypeError,
    );
    await assert.rejects(
      reserveVisibilityOperation(neverTouchDb, { operationId: "op", workspaceId: "ws", aiTests: 1, limit: -1 }),
      TypeError,
    );
  });
});
