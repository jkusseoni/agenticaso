/**
 * One request-scoped interface to the durable Visibility operation ledger.
 * The handler will adopt this only after adapter and handler tests pass.
 */
import { randomUUID } from "node:crypto";
import { reserveVisibilityOperation, releaseVisibilityOperation } from "./visibility-reservation.js";
import { settleVisibilityOperation } from "./visibility-settlement.js";

export function createVisibilityUsageSession({
  prisma, workspaceId, operationId = randomUUID(),
  reserve = reserveVisibilityOperation,
  settle = settleVisibilityOperation,
  release = releaseVisibilityOperation,
}) {
  if (!prisma || typeof workspaceId !== "string" || !workspaceId ||
      typeof operationId !== "string" || !operationId) {
    throw new TypeError("Invalid visibility usage session");
  }

  return {
    operationId,
    async reserve({ aiTests, limit = null, now = new Date() }) {
      const result = await reserve(prisma, { operationId, workspaceId, aiTests, limit, now });
      if (result.status === "reserved") return { ok: true, reserved: result.reserved };
      if (result.status === "insufficient_allowance") return { ok: false, reason: "insufficient_allowance" };
      // An operation already committed or released must never start new provider work.
      throw new Error(`Visibility reservation conflict: ${result.status}`);
    },
    async commit(actualAiTests) {
      const result = await settle(prisma, { operationId, workspaceId, actualAiTests });
      if (result.status === "committed" || result.status === "already_committed") return true;
      throw new Error(`Visibility settlement rejected: ${result.status}`);
    },
    async release() {
      const result = await release(prisma, { operationId, workspaceId });
      if (result.status === "released" || result.status === "committed") return true;
      throw new Error(`Visibility release rejected: ${result.status}`);
    },
  };
}
