import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, it } from "node:test";
import { getEntitlements } from "../entitlements.js";
import { createVisibilityUsageSession } from "../visibility-usage-session.js";
import { handleVisibilityRequest } from "../../visibility/handler.js";
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

  it("enforces allowance across concurrent distinct operations", async () => {
    const workspaceId = await setup();
    try {
      const results = await Promise.all([
        reserveVisibilityOperation(prisma, { operationId: randomUUID(), workspaceId, aiTests: 7, limit: 10 }),
        reserveVisibilityOperation(prisma, { operationId: randomUUID(), workspaceId, aiTests: 7, limit: 10 }),
      ]);
      assert.deepEqual(results.map(x => x.status).sort(), ["insufficient_allowance", "reserved"]);
      const usage = await period(workspaceId);
      assert.equal(usage.aiTestsReserved, 7);
      assert.equal(usage.aiTests, 0);
    } finally { await cleanup(workspaceId); }
  });

  it("rejects operation ID reuse with a different amount or workspace", async () => {
    const workspaceId = await setup();
    const otherWorkspaceId = await setup();
    const operationId = randomUUID();
    try {
      await reserveVisibilityOperation(prisma, { operationId, workspaceId, aiTests: 6, limit: 20 });
      assert.equal((await reserveVisibilityOperation(prisma, { operationId, workspaceId, aiTests: 7, limit: 20 })).status, "conflict");
      assert.equal((await reserveVisibilityOperation(prisma, { operationId, workspaceId: otherWorkspaceId, aiTests: 6, limit: 20 })).status, "conflict");
      assert.equal((await period(workspaceId)).aiTestsReserved, 6);
      assert.equal(await prisma.usagePeriod.count({ where: { workspaceId: otherWorkspaceId } }), 0);
    } finally {
      await cleanup(workspaceId);
      await cleanup(otherWorkspaceId);
    }
  });

  it("rejects operation ID reuse in a different UTC billing month", async () => {
    const workspaceId = await setup();
    const operationId = randomUUID();
    try {
      assert.equal((await reserveVisibilityOperation(prisma, {
        operationId, workspaceId, aiTests: 5, limit: 10,
        now: new Date("2026-09-30T23:59:59.000Z"),
      })).status, "reserved");
      assert.equal((await reserveVisibilityOperation(prisma, {
        operationId, workspaceId, aiTests: 5, limit: 10,
        now: new Date("2026-10-01T00:00:01.000Z"),
      })).status, "conflict");
      assert.equal(await prisma.usagePeriod.count({ where: { workspaceId } }), 1);
    } finally { await cleanup(workspaceId); }
  });

  it("runs the HTTP handler against the real PostgreSQL operation ledger", async () => {
    const workspaceId = await setup();
    const operationIds = [];
    const chat = async (_model, messages, opts = {}) => {
      const system = messages[0].content;
      if (system.includes("You identify a business")) {
        return JSON.stringify({ brand: "Acme", category: "mugs", whatTheySell: "mugs", isEcommerce: true });
      }
      if (system.includes("generate realistic buyer search queries")) {
        return JSON.stringify(["q1", "q2", "q3", "q4", "q5"]);
      }
      return opts.web ? "Acme mugs recommended" : "Acme is recommended";
    };
    const subscription = {
      plan: "pro", status: "active", provider: "paddle",
      providerSubscriptionId: "sub_ci_visibility",
      currentPeriodEnd: new Date(Date.now() + 86400000),
    };
    try {
      const gate = {
        ok: true, userId: "ci_user", workspace: { id: workspaceId },
        prisma, entitlements: getEntitlements(subscription), usage: { aiTests: 0 },
      };
      const response = await handleVisibilityRequest({
        gate, body: { url: "acme.com" },
        deps: {
          chat, configured: true, rateLimited: () => false,
          fetchPage: async () => ({ ok: true, text: "<title>Acme mugs</title>" }),
          usageSessionFactory: (input) => {
            const session = createVisibilityUsageSession(input);
            operationIds.push(session.operationId);
            return session;
          },
        },
      });
      assert.equal(response.status, 200, JSON.stringify(await response.json()));
      assert.equal(operationIds.length, 1);
      const op = await prisma.visibilityUsageOperation.findUniqueOrThrow({ where: { id: operationIds[0] } });
      assert.equal(op.status, "committed");
      assert.equal(op.reservedAiTests, 10);
      assert.equal(op.actualAiTests, 10);
      const usage = await period(workspaceId);
      assert.equal(usage.aiTests, 10);
      assert.equal(usage.aiTestsReserved, 0);
    } finally { await cleanup(workspaceId); }
  });

  it("releases real PostgreSQL reservation when all web providers fail", async () => {
    const workspaceId = await setup();
    const operationIds = [];
    const chat = async (_model, messages, opts = {}) => {
      const system = messages[0].content;
      if (system.includes("You identify a business")) {
        return JSON.stringify({ brand: "Acme", category: "mugs", whatTheySell: "mugs", isEcommerce: true });
      }
      if (system.includes("generate realistic buyer search queries")) {
        return JSON.stringify(["q1", "q2", "q3", "q4", "q5"]);
      }
      if (opts.web) throw new Error("simulated web provider outage");
      return "Acme mugs recommended";
    };
    const subscription = {
      plan: "pro", status: "active", provider: "paddle",
      providerSubscriptionId: "sub_ci_visibility_failure",
      currentPeriodEnd: new Date(Date.now() + 86400000),
    };
    try {
      const response = await handleVisibilityRequest({
        gate: {
          ok: true, userId: "ci_user", workspace: { id: workspaceId },
          prisma, entitlements: getEntitlements(subscription), usage: { aiTests: 0 },
        },
        body: { url: "acme.com" },
        deps: {
          chat, configured: true, rateLimited: () => false,
          fetchPage: async () => ({ ok: true, text: "<title>Acme mugs</title>" }),
          usageSessionFactory: (input) => {
            const session = createVisibilityUsageSession(input);
            operationIds.push(session.operationId);
            return session;
          },
        },
      });
      assert.equal(response.status, 502);
      assert.equal(operationIds.length, 1);
      const op = await prisma.visibilityUsageOperation.findUniqueOrThrow({ where: { id: operationIds[0] } });
      assert.equal(op.status, "released");
      const usage = await period(workspaceId);
      assert.equal(usage.aiTests, 0);
      assert.equal(usage.aiTestsReserved, 0);
    } finally { await cleanup(workspaceId); }
  });
});
