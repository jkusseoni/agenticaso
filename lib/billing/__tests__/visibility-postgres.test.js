import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, it } from "node:test";
import { reserveVisibilityOperation, releaseVisibilityOperation } from "../visibility-reservation.js";
import { settleVisibilityOperation } from "../visibility-settlement.js";

const dbUrl = process.env.VISIBILITY_TEST_DATABASE_URL;
const integration = dbUrl ? describe : describe.skip;

integration("visibility operation PostgreSQL integration", () => {
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  async function setup() {
    const workspace = await prisma.workspace.create({
      data: { clerkUserId: `ci_visibility_${randomUUID()}` },
    });
    return workspace.id;
  }
  async function cleanup(workspaceId) {
    await prisma.workspace.delete({ where: { id: workspaceId } });
  }
  async function period(workspaceId) {
    return prisma.usagePeriod.findFirstOrThrow({ where: { workspaceId } });
  }

  it("duplicate reserve and duplicate settle charge once", async () => {
    const workspaceId = await setup();
    const operationId = randomUUID();
    try {
      const args = { operationId, workspaceId, aiTests: 10, limit: 20 };
      assert.equal((await reserveVisibilityOperation(prisma, args)).status, "reserved");
      assert.equal((await reserveVisibilityOperation(prisma, args)).status, "reserved");
      assert.equal((await period(workspaceId)).aiTestsReserved, 10);
      assert.equal((await settleVisibilityOperation(prisma, { operationId, workspaceId, actualAiTests: 7 })).status, "committed");
      assert.equal((await settleVisibilityOperation(prisma, { operationId, workspaceId, actualAiTests: 7 })).status, "already_committed");
      const usage = await period(workspaceId);
      assert.equal(usage.aiTests, 7);
      assert.equal(usage.aiTestsReserved, 0);
    } finally { await cleanup(workspaceId); }
  });

  it("concurrent duplicate settlements only charge once", async () => {
    const workspaceId = await setup();
    const operationId = randomUUID();
    try {
      await reserveVisibilityOperation(prisma, { operationId, workspaceId, aiTests: 10, limit: 20 });
      const outcomes = await Promise.all([
        settleVisibilityOperation(prisma, { operationId, workspaceId, actualAiTests: 5 }),
        settleVisibilityOperation(prisma, { operationId, workspaceId, actualAiTests: 5 }),
      ]);
      assert.deepEqual(outcomes.map(x => x.status).sort(), ["already_committed", "committed"]);
      const usage = await period(workspaceId);
      assert.equal(usage.aiTests, 5);
      assert.equal(usage.aiTestsReserved, 0);
    } finally { await cleanup(workspaceId); }
  });

  it("release is idempotent and cannot undo committed usage", async () => {
    const workspaceId = await setup();
    const operationId = randomUUID();
    try {
      await reserveVisibilityOperation(prisma, { operationId, workspaceId, aiTests: 10, limit: 20 });
      assert.equal((await releaseVisibilityOperation(prisma, { operationId, workspaceId })).status, "released");
      assert.equal((await releaseVisibilityOperation(prisma, { operationId, workspaceId })).status, "released");
      assert.equal((await settleVisibilityOperation(prisma, { operationId, workspaceId, actualAiTests: 5 })).status, "already_released");
      const usage = await period(workspaceId);
      assert.equal(usage.aiTests, 0);
      assert.equal(usage.aiTestsReserved, 0);
    } finally { await cleanup(workspaceId); }
  });

  it("commit versus release ends in exactly one terminal state", async () => {
    const workspaceId = await setup();
    const operationId = randomUUID();
    try {
      await reserveVisibilityOperation(prisma, { operationId, workspaceId, aiTests: 10, limit: 20 });
      const outcomes = await Promise.all([
        settleVisibilityOperation(prisma, { operationId, workspaceId, actualAiTests: 5 }),
        releaseVisibilityOperation(prisma, { operationId, workspaceId }),
      ]);
      const usage = await period(workspaceId);
      assert.equal(usage.aiTestsReserved, 0);
      assert.ok(usage.aiTests === 0 || usage.aiTests === 5);
      const op = await prisma.visibilityUsageOperation.findUniqueOrThrow({ where: { id: operationId } });
      assert.ok(["committed", "released"].includes(op.status));
      assert.ok(outcomes.some(x => x.status === op.status));
    } finally { await cleanup(workspaceId); }
  });
});
