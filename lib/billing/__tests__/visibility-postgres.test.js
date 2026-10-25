import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, it } from "node:test";
import { getEntitlements } from "../entitlements.js";
import { createVisibilityUsageSession } from "../visibility-usage-session.js";
import { inspectVisibilityOperation, listStaleVisibilityReservations } from "../visibility-recovery.js";
import { recordVisibilityRecoveryHold } from "../visibility-recovery-audit.js";
import { listVisibilityRecoveryReviews } from "../visibility-recovery-history.js";
import { handleVisibilityRequest } from "../../visibility/handler.js";
import { reserveVisibilityOperation, releaseVisibilityOperation } from "../visibility-reservation.js";
import { settleVisibilityOperation } from "../visibility-settlement.js";
import { reserveUsage, commitUsage, releaseUsage } from "../usage.js";

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
    // Test-only teardown: retention intentionally blocks deleting parents while reviews exist.
    await prisma.visibilityRecoveryReview.deleteMany({ where: { workspaceId } });
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

  it("releases the real PostgreSQL reservation when all web answers fail", async () => {
    const workspaceId = await setup();
    const operationIds = [];
    const subscription = {
      plan: "pro", status: "active", provider: "paddle",
      providerSubscriptionId: "sub_ci_failure",
      currentPeriodEnd: new Date(Date.now() + 86400000),
    };
    try {
      const gate = {
        ok: true, userId: "ci_failure_user", workspace: { id: workspaceId },
        prisma, entitlements: getEntitlements(subscription), usage: { aiTests: 0 },
      };
      const response = await handleVisibilityRequest({
        gate, body: { url: "acme.com" },
        deps: {
          configured: true, rateLimited: () => false,
          fetchPage: async () => ({ ok: true, text: "<title>Acme mugs</title>" }),
          chat: async (_model, messages, opts = {}) => {
            const system = messages[0].content;
            if (system.includes("You identify a business")) {
              return JSON.stringify({ brand: "Acme", category: "mugs", whatTheySell: "mugs", isEcommerce: true });
            }
            if (system.includes("generate realistic buyer search queries")) {
              return JSON.stringify(["q1", "q2", "q3", "q4", "q5"]);
            }
            if (opts.web) throw new Error("web provider unavailable");
            return "Acme mugs recommended";
          },
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

  it("charges exactly once when PostgreSQL commits but settlement response is lost", async () => {
    const workspaceId = await setup();
    const operationIds = [];
    let settlementCalls = 0;
    const subscription = {
      plan: "pro", status: "active", provider: "paddle",
      providerSubscriptionId: "sub_ci_lost_response",
      currentPeriodEnd: new Date(Date.now() + 86400000),
    };
    try {
      const gate = {
        ok: true, userId: "ci_lost_response_user", workspace: { id: workspaceId },
        prisma, entitlements: getEntitlements(subscription), usage: { aiTests: 0 },
      };
      const response = await handleVisibilityRequest({
        gate, body: { url: "acme.com" },
        deps: {
          configured: true, rateLimited: () => false,
          fetchPage: async () => ({ ok: true, text: "<title>Acme mugs</title>" }),
          chat: async (_model, messages, opts = {}) => {
            const system = messages[0].content;
            if (system.includes("You identify a business")) {
              return JSON.stringify({ brand: "Acme", category: "mugs", whatTheySell: "mugs", isEcommerce: true });
            }
            if (system.includes("generate realistic buyer search queries")) {
              return JSON.stringify(["q1", "q2", "q3", "q4", "q5"]);
            }
            return opts.web ? "Acme mugs recommended" : "Acme is recommended";
          },
          usageSessionFactory: (input) => {
            const session = createVisibilityUsageSession({
              ...input,
              settle: async (db, args) => {
                settlementCalls += 1;
                const result = await settleVisibilityOperation(db, args);
                if (settlementCalls === 1) throw new Error("response lost after database commit");
                return result;
              },
            });
            operationIds.push(session.operationId);
            return session;
          },
        },
      });
      assert.equal(response.status, 200);
      assert.equal(settlementCalls, 2);
      assert.equal(operationIds.length, 1);
      const op = await prisma.visibilityUsageOperation.findUniqueOrThrow({ where: { id: operationIds[0] } });
      assert.equal(op.status, "committed");
      assert.equal(op.actualAiTests, 10);
      const usage = await period(workspaceId);
      assert.equal(usage.aiTests, 10);
      assert.equal(usage.aiTestsReserved, 0);
    } finally { await cleanup(workspaceId); }
  });

  it("returns 503 without releasing a committed charge when both settlement responses are lost", async () => {
    const workspaceId = await setup();
    const operationIds = [];
    let settlementCalls = 0;
    let releaseCalls = 0;
    const subscription = {
      plan: "pro", status: "active", provider: "paddle",
      providerSubscriptionId: "sub_ci_both_lost",
      currentPeriodEnd: new Date(Date.now() + 86400000),
    };
    try {
      const gate = {
        ok: true, userId: "ci_both_lost_user", workspace: { id: workspaceId },
        prisma, entitlements: getEntitlements(subscription), usage: { aiTests: 0 },
      };
      const response = await handleVisibilityRequest({
        gate, body: { url: "acme.com" },
        deps: {
          configured: true, rateLimited: () => false,
          fetchPage: async () => ({ ok: true, text: "<title>Acme mugs</title>" }),
          chat: async (_model, messages, opts = {}) => {
            const system = messages[0].content;
            if (system.includes("You identify a business")) {
              return JSON.stringify({ brand: "Acme", category: "mugs", whatTheySell: "mugs", isEcommerce: true });
            }
            if (system.includes("generate realistic buyer search queries")) {
              return JSON.stringify(["q1", "q2", "q3", "q4", "q5"]);
            }
            return opts.web ? "Acme mugs recommended" : "Acme is recommended";
          },
          usageSessionFactory: (input) => {
            const session = createVisibilityUsageSession({
              ...input,
              settle: async (db, args) => {
                settlementCalls += 1;
                await settleVisibilityOperation(db, args);
                throw new Error("settlement response lost");
              },
              release: async (db, args) => {
                releaseCalls += 1;
                return releaseVisibilityOperation(db, args);
              },
            });
            operationIds.push(session.operationId);
            return session;
          },
        },
      });
      assert.equal(response.status, 503);
      assert.equal(settlementCalls, 2);
      assert.equal(releaseCalls, 0);
      assert.equal(operationIds.length, 1);
      const op = await prisma.visibilityUsageOperation.findUniqueOrThrow({ where: { id: operationIds[0] } });
      assert.equal(op.status, "committed");
      assert.equal(op.actualAiTests, 10);
      const usage = await period(workspaceId);
      assert.equal(usage.aiTests, 10);
      assert.equal(usage.aiTestsReserved, 0);
    } finally { await cleanup(workspaceId); }
  });

  it("finds only stale reserved operations without changing their usage", async () => {
    const workspaceId = await setup();
    const oldId = randomUUID();
    const recentId = randomUUID();
    const committedId = randomUUID();
    const now = new Date();
    const cutoff = new Date(now.getTime() - 60 * 60 * 1000);
    try {
      for (const operationId of [oldId, recentId, committedId]) {
        assert.equal((await reserveVisibilityOperation(prisma, {
          operationId, workspaceId, aiTests: 3, limit: 20, now,
        })).status, "reserved");
      }
      await prisma.visibilityUsageOperation.update({
        where: { id: oldId },
        data: { createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000) },
      });
      await prisma.visibilityUsageOperation.update({
        where: { id: committedId },
        data: { createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000) },
      });
      assert.equal((await settleVisibilityOperation(prisma, {
        operationId: committedId, workspaceId, actualAiTests: 2,
      })).status, "committed");
      const found = await listStaleVisibilityReservations(prisma, { olderThan: cutoff });
      assert.deepEqual(found.filter((op) => op.workspaceId === workspaceId).map((op) => op.id), [oldId]);
      const usage = await period(workspaceId);
      assert.equal(usage.aiTests, 2);
      assert.equal(usage.aiTestsReserved, 6);
      assert.equal((await prisma.visibilityUsageOperation.findUniqueOrThrow({ where: { id: oldId } })).status, "reserved");
    } finally { await cleanup(workspaceId); }
  });

  it("inspects PostgreSQL operation state without changing usage or exposing another workspace", async () => {
    const workspaceId = await setup();
    const otherWorkspaceId = await setup();
    const operationId = randomUUID();
    try {
      assert.equal((await reserveVisibilityOperation(prisma, {
        operationId, workspaceId, aiTests: 4, limit: 20, now: new Date(),
      })).status, "reserved");
      const reserved = await inspectVisibilityOperation(prisma, { operationId, workspaceId });
      assert.equal(reserved.status, "reserved");
      assert.equal(reserved.action, "manual_review");
      assert.deepEqual(await inspectVisibilityOperation(prisma, {
        operationId, workspaceId: otherWorkspaceId,
      }), { status: "not_found", action: "none" });
      let usage = await period(workspaceId);
      assert.equal(usage.aiTests, 0);
      assert.equal(usage.aiTestsReserved, 4);

      assert.equal((await settleVisibilityOperation(prisma, {
        operationId, workspaceId, actualAiTests: 3,
      })).status, "committed");
      const committed = await inspectVisibilityOperation(prisma, { operationId, workspaceId });
      assert.equal(committed.status, "committed");
      assert.equal(committed.action, "none");
      usage = await period(workspaceId);
      assert.equal(usage.aiTests, 3);
      assert.equal(usage.aiTestsReserved, 0);
    } finally {
      await cleanup(workspaceId);
      await cleanup(otherWorkspaceId);
    }
  });

  it("records HOLD review in PostgreSQL without changing usage or exposing other workspaces", async () => {
    const workspaceId = await setup();
    const otherWorkspaceId = await setup();
    const operationId = randomUUID();
    const input = {
      operationId, workspaceId, reviewerId: "ci_reviewer",
      reason: "Provider result cannot yet be verified",
      evidence: ["incident:CI-RECOVERY-1"],
    };
    try {
      assert.equal((await reserveVisibilityOperation(prisma, {
        operationId, workspaceId, aiTests: 5, limit: 20, now: new Date(),
      })).status, "reserved");

      assert.equal((await recordVisibilityRecoveryHold(prisma, {
        ...input, workspaceId: otherWorkspaceId,
      })).status, "not_found");
      assert.equal(await prisma.visibilityRecoveryReview.count({
        where: { operationId },
      }), 0);

      const recorded = await recordVisibilityRecoveryHold(prisma, input);
      assert.equal(recorded.status, "recorded");
      const reviews = await prisma.visibilityRecoveryReview.findMany({
        where: { operationId },
      });
      assert.equal(reviews.length, 1);
      assert.equal(reviews[0].workspaceId, workspaceId);
      assert.equal(reviews[0].reviewerId, "ci_reviewer");
      assert.equal(reviews[0].decision, "hold");
      assert.deepEqual(reviews[0].evidence, ["incident:CI-RECOVERY-1"]);

      let usage = await period(workspaceId);
      assert.equal(usage.aiTests, 0);
      assert.equal(usage.aiTestsReserved, 5);
      assert.equal((await prisma.visibilityUsageOperation.findUniqueOrThrow({
        where: { id: operationId },
      })).status, "reserved");

      assert.equal((await settleVisibilityOperation(prisma, {
        operationId, workspaceId, actualAiTests: 3,
      })).status, "committed");
      assert.equal((await recordVisibilityRecoveryHold(prisma, input)).status, "not_reserved");
      assert.equal(await prisma.visibilityRecoveryReview.count({
        where: { operationId },
      }), 1);
      usage = await period(workspaceId);
      assert.equal(usage.aiTests, 3);
      assert.equal(usage.aiTestsReserved, 0);
    } finally {
      await cleanup(workspaceId);
      await cleanup(otherWorkspaceId);
    }
  });

  it("serializes concurrent HOLD review and settlement without changing charge totals", async () => {
    const workspaceId = await setup();
    const operationId = randomUUID();
    try {
      assert.equal((await reserveVisibilityOperation(prisma, {
        operationId, workspaceId, aiTests: 6, limit: 20, now: new Date(),
      })).status, "reserved");
      const [review, settlement] = await Promise.all([
        recordVisibilityRecoveryHold(prisma, {
          operationId, workspaceId, reviewerId: "ci_race_reviewer",
          reason: "Awaiting provider evidence", evidence: ["incident:CI-RACE-1"],
        }),
        settleVisibilityOperation(prisma, { operationId, workspaceId, actualAiTests: 4 }),
      ]);
      assert.equal(settlement.status, "committed");
      assert.ok(["recorded", "not_reserved"].includes(review.status));
      const reviews = await prisma.visibilityRecoveryReview.findMany({
        where: { operationId },
      });
      assert.equal(reviews.length, review.status === "recorded" ? 1 : 0);
      const usage = await period(workspaceId);
      assert.equal(usage.aiTests, 4);
      assert.equal(usage.aiTestsReserved, 0);
      assert.equal((await prisma.visibilityUsageOperation.findUniqueOrThrow({
        where: { id: operationId },
      })).status, "committed");
    } finally { await cleanup(workspaceId); }
  });

  it("isolates PostgreSQL recovery review history by workspace and operation", async () => {
    const workspaceId = await setup();
    const otherWorkspaceId = await setup();
    const operationId = randomUUID();
    const secondOperationId = randomUUID();
    try {
      for (const id of [operationId, secondOperationId]) {
        assert.equal((await reserveVisibilityOperation(prisma, {
          operationId: id, workspaceId, aiTests: 2, limit: 20, now: new Date(),
        })).status, "reserved");
      }
      for (const id of [operationId, secondOperationId]) {
        assert.equal((await recordVisibilityRecoveryHold(prisma, {
          operationId: id, workspaceId, reviewerId: "ci_history_reviewer",
          reason: "Awaiting provider verification",
          evidence: ["incident:CI-HISTORY"],
        })).status, "recorded");
      }
      const owned = await listVisibilityRecoveryReviews(prisma, {
        operationId, workspaceId,
      });
      assert.equal(owned.length, 1);
      assert.equal(owned[0].operationId, operationId);
      assert.equal(owned[0].workspaceId, workspaceId);
      assert.equal(owned[0].reviewerId, "ci_history_reviewer");
      assert.deepEqual(owned[0].evidence, ["incident:CI-HISTORY"]);
      assert.deepEqual(await listVisibilityRecoveryReviews(prisma, {
        operationId, workspaceId: otherWorkspaceId,
      }), []);
      assert.deepEqual(await listVisibilityRecoveryReviews(prisma, {
        operationId: secondOperationId, workspaceId: otherWorkspaceId,
      }), []);
      const usage = await period(workspaceId);
      assert.equal(usage.aiTests, 0);
      assert.equal(usage.aiTestsReserved, 4);
    } finally {
      await cleanup(workspaceId);
      await cleanup(otherWorkspaceId);
    }
  });

  it("rejects unsafe recovery audit decisions at the PostgreSQL constraint layer", async () => {
    const workspaceId = await setup();
    const operationId = randomUUID();
    try {
      assert.equal((await reserveVisibilityOperation(prisma, {
        operationId, workspaceId, aiTests: 2, limit: 20, now: new Date(),
      })).status, "reserved");
      for (const invalid of [
        { decision: "release", evidence: ["incident:CI-1"], reviewerId: "ci_reviewer" },
        { decision: "settle", evidence: ["incident:CI-1"], reviewerId: "ci_reviewer" },
        { decision: "hold", evidence: [], reviewerId: "ci_reviewer" },
        { decision: "hold", evidence: ["incident:CI-1"], reviewerId: " " },
      ]) {
        await assert.rejects(prisma.visibilityRecoveryReview.create({
          data: {
            operationId, workspaceId, reason: "CI constraint test",
            ...invalid,
          },
        }));
      }
      assert.equal(await prisma.visibilityRecoveryReview.count({
        where: { operationId },
      }), 0);
      const usage = await period(workspaceId);
      assert.equal(usage.aiTests, 0);
      assert.equal(usage.aiTestsReserved, 2);
    } finally { await cleanup(workspaceId); }
  });

  it("retains HOLD review history by rejecting deletion of its parent operation", async () => {
    const workspaceId = await setup();
    const operationId = randomUUID();
    try {
      assert.equal((await reserveVisibilityOperation(prisma, {
        operationId, workspaceId, aiTests: 2, limit: 20, now: new Date(),
      })).status, "reserved");
      assert.equal((await recordVisibilityRecoveryHold(prisma, {
        operationId, workspaceId, reviewerId: "ci_retention_reviewer",
        reason: "Pending reconciliation", evidence: ["incident:CI-RETENTION"],
      })).status, "recorded");
      await assert.rejects(prisma.visibilityUsageOperation.delete({
        where: { id: operationId },
      }));
      assert.equal(await prisma.visibilityRecoveryReview.count({
        where: { operationId },
      }), 1);
      assert.equal((await prisma.visibilityUsageOperation.findUniqueOrThrow({
        where: { id: operationId },
      })).status, "reserved");
    } finally { await cleanup(workspaceId); }
  });

  it("mixed legacy and operation-ledger reservations share one quota", async () => {
    const workspaceId = await setup();
    const operationId = randomUUID();
    const limit = 10;
    try {
      const [legacy, ledger] = await Promise.all([
        reserveUsage(prisma, workspaceId, { aiTests: 7, limit }),
        reserveVisibilityOperation(prisma, {
          operationId, workspaceId, aiTests: 7, limit, now: new Date(),
        }),
      ]);
      const admitted = Number(legacy.ok) + Number(ledger.status === "reserved");
      assert.equal(admitted, 1, "only one of two 7-test reservations fits quota 10");
      const usage = await period(workspaceId);
      assert.equal(usage.aiTests, 0);
      assert.equal(usage.aiTestsReserved, 7);
      assert.ok(usage.aiTests + usage.aiTestsReserved <= limit);
      if (legacy.ok) {
        assert.equal(ledger.status, "insufficient_allowance");
        await releaseUsage(prisma, workspaceId, { reservedAiTests: 7 });
      } else {
        assert.equal(ledger.status, "reserved");
        assert.equal((await releaseVisibilityOperation(prisma, {
          operationId, workspaceId,
        })).status, "released");
      }
      const after = await period(workspaceId);
      assert.equal(after.aiTests, 0);
      assert.equal(after.aiTestsReserved, 0);
    } finally { await cleanup(workspaceId); }
  });

  it("mixed legacy and ledger settlements preserve shared counters", async () => {
    const workspaceId = await setup();
    const operationId = randomUUID();
    const limit = 20;
    try {
      const [legacy, ledger] = await Promise.all([
        reserveUsage(prisma, workspaceId, { aiTests: 7, limit }),
        reserveVisibilityOperation(prisma, {
          operationId, workspaceId, aiTests: 7, limit, now: new Date(),
        }),
      ]);
      assert.equal(legacy.ok, true);
      assert.equal(ledger.status, "reserved");
      assert.equal((await period(workspaceId)).aiTestsReserved, 14);
      const [legacyCommitted, ledgerCommitted] = await Promise.all([
        commitUsage(prisma, workspaceId, {
          reservedAiTests: 7, actualAiTests: 5,
        }),
        settleVisibilityOperation(prisma, {
          operationId, workspaceId, actualAiTests: 4,
        }),
      ]);
      assert.ok(legacyCommitted);
      assert.equal(ledgerCommitted.status, "committed");
      const usage = await period(workspaceId);
      assert.equal(usage.aiTests, 9);
      assert.equal(usage.aiTestsReserved, 0);
      assert.ok(usage.aiTests <= limit);
      assert.equal((await settleVisibilityOperation(prisma, {
        operationId, workspaceId, actualAiTests: 4,
      })).status, "already_committed");
      assert.equal((await period(workspaceId)).aiTests, 9);
    } finally { await cleanup(workspaceId); }
  });
});
