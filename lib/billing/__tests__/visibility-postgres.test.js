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
import { recordClerkVisibilityRecoveryHold } from "../visibility-recovery-clerk.js";
import { changeRecoveryAdminGrant } from "../visibility-recovery-grant-admin.js";

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

  it("audits grant and revoke atomically and enforces current permissions", async () => {
    const workspaceId = await setup();
    const actorId = `ci_grant_${randomUUID()}`;
    const operatorId = `ci_operator_${randomUUID()}`;
    const authorizeOperator = async ({ operatorId: id }) => id === operatorId;
    const grantInput = {
      operatorId, targetActorId: actorId, action: "grant",
      workspaceIds: [workspaceId], permissions: ["visibility.recovery.hold"],
      reason: "CI scoped access review",
    };
    try {
      await assert.rejects(changeRecoveryAdminGrant(prisma, grantInput),
        /authorization denied/);
      assert.equal(await prisma.visibilityRecoveryAdminGrant.count({
        where: { actorId },
      }), 0);
      assert.deepEqual(await changeRecoveryAdminGrant(prisma, grantInput,
        { authorizeOperator }), { status: "granted", targetActorId: actorId });
      let grant = await prisma.visibilityRecoveryAdminGrant.findUniqueOrThrow({
        where: { actorId },
      });
      assert.equal(grant.enabled, true);
      assert.deepEqual(grant.workspaceIds, [workspaceId]);
      assert.deepEqual(grant.permissions, ["visibility.recovery.hold"]);
      await assert.rejects(changeRecoveryAdminGrant(prisma, {
        ...grantInput, action: "grant", permissions: ["visibility.recovery.settle"],
      }, { authorizeOperator }), /Invalid recovery grant/);
      assert.deepEqual(await changeRecoveryAdminGrant(prisma, {
        operatorId, targetActorId: actorId, action: "revoke",
        reason: "CI revoke after review",
      }, { authorizeOperator }), { status: "revoked", targetActorId: actorId });
      grant = await prisma.visibilityRecoveryAdminGrant.findUniqueOrThrow({
        where: { actorId },
      });
      assert.equal(grant.enabled, false);
      assert.deepEqual(grant.workspaceIds, []);
      assert.deepEqual(grant.permissions, []);
      const audits = await prisma.visibilityRecoveryGrantAudit.findMany({
        where: { targetActorId: actorId }, orderBy: { createdAt: "asc" },
      });
      assert.equal(audits.length, 2);
      assert.deepEqual(audits.map(x => x.action), ["grant", "revoke"]);
      assert.equal(audits[0].operatorId, operatorId);
      assert.equal(audits[0].beforeState, null);
      assert.equal(audits[0].afterState.enabled, true);
      assert.equal(audits[1].beforeState.enabled, true);
      assert.equal(audits[1].afterState.enabled, false);
      await assert.rejects(prisma.visibilityRecoveryGrantAudit.delete({
        where: { id: audits[0].id },
      }));
      await assert.rejects(prisma.visibilityRecoveryGrantAudit.update({
        where: { id: audits[0].id }, data: { reason: "tampered" },
      }));
      assert.equal(await prisma.visibilityRecoveryGrantAudit.count({
        where: { targetActorId: actorId },
      }), 2);
    } finally {
      // Audit is append-only even during test cleanup. The test actor is unique.
      await prisma.visibilityRecoveryAdminGrant.deleteMany({ where: { actorId } });
      await cleanup(workspaceId);
    }
  });

  it("concurrent legacy period initialization reuses one UTC month row", async () => {
    const workspaceId = await setup();
    const now = new Date("2026-10-15T12:00:00.000Z");
    try {
      const reservations = await Promise.all(
        Array.from({ length: 6 }, () =>
          reserveUsage(prisma, workspaceId, { aiTests: 1, limit: 10 }, now)
        )
      );
      assert.ok(reservations.every((result) => result.ok === true));
      assert.equal(await prisma.usagePeriod.count({ where: { workspaceId } }), 1);
      const usage = await period(workspaceId);
      assert.equal(usage.aiTestsReserved, 6);
      assert.equal(usage.aiTests, 0);
      await releaseUsage(prisma, workspaceId, { reservedAiTests: 6 }, now);
      assert.equal((await period(workspaceId)).aiTestsReserved, 0);
    } finally { await cleanup(workspaceId); }
  });

  it("Clerk recovery HOLD requires current scoped database grant", async () => {
    const workspaceId = await setup();
    const otherWorkspaceId = await setup();
    const operationId = randomUUID();
    const actorId = `ci_recovery_admin_${randomUUID()}`;
    const request = {
      operationId, workspaceId, evidence: ["incident:CI-AUTH"],
      reason: "Manual reconciliation pending", reviewerId: "spoofed",
    };
    const invoke = (userId = actorId, overrides = {}) =>
      recordClerkVisibilityRecoveryHold(prisma, { ...request, ...overrides }, {
        getAuth: async () => ({ userId }),
      });
    try {
      assert.equal((await reserveVisibilityOperation(prisma, {
        operationId, workspaceId, aiTests: 2, limit: 10,
      })).status, "reserved");
      await assert.rejects(invoke(null), /authentication required/);
      await assert.rejects(invoke(), /denied/);
      await prisma.visibilityRecoveryAdminGrant.create({
        data: {
          actorId, enabled: false, workspaceIds: [workspaceId],
          permissions: ["visibility.recovery.hold"],
        },
      });
      await assert.rejects(invoke(), /denied/);
      await prisma.visibilityRecoveryAdminGrant.update({
        where: { actorId }, data: { enabled: true },
      });
      await assert.rejects(invoke("another-user"), /denied/);
      await assert.rejects(invoke(actorId, { workspaceId: otherWorkspaceId }), /denied/);
      assert.equal((await invoke()).status, "recorded");
      const review = await prisma.visibilityRecoveryReview.findFirstOrThrow({
        where: { operationId },
      });
      assert.equal(review.reviewerId, actorId);
      assert.equal(review.decision, "hold");
      await prisma.visibilityRecoveryAdminGrant.update({
        where: { actorId }, data: { enabled: false },
      });
      await assert.rejects(invoke(), /denied/);
      assert.equal(await prisma.visibilityRecoveryReview.count({ where: { operationId } }), 1);
      assert.equal((await period(workspaceId)).aiTestsReserved, 2);
    } finally {
      await prisma.visibilityRecoveryAdminGrant.deleteMany({ where: { actorId } });
      await cleanup(workspaceId);
      await cleanup(otherWorkspaceId);
    }
  });

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

  it("mixed-mode settlement across UTC month boundary charges original periods", async () => {
    const workspaceId = await setup();
    const operationId = randomUUID();
    const beforeMidnight = new Date("2026-10-31T23:59:59.000Z");
    const afterMidnight = new Date("2026-11-01T00:00:01.000Z");
    try {
      const legacy = await reserveUsage(prisma, workspaceId, {
        aiTests: 6, limit: 20,
      }, beforeMidnight);
      assert.equal(legacy.ok, true);
      const ledger = await reserveVisibilityOperation(prisma, {
        operationId, workspaceId, aiTests: 7, limit: 20, now: beforeMidnight,
      });
      assert.equal(ledger.status, "reserved");
      // Legacy handler carries periodAt from reservation through settlement.
      await commitUsage(prisma, workspaceId, {
        reservedAiTests: 6, actualAiTests: 4,
      }, beforeMidnight);
      assert.equal((await settleVisibilityOperation(prisma, {
        operationId, workspaceId, actualAiTests: 5,
      })).status, "committed");
      const october = await prisma.usagePeriod.findUniqueOrThrow({
        where: { workspaceId_periodStart: {
          workspaceId, periodStart: new Date("2026-10-01T00:00:00.000Z"),
        } },
      });
      assert.equal(october.aiTests, 9);
      assert.equal(october.aiTestsReserved, 0);
      // A new request after midnight belongs to the next period.
      const november = await reserveUsage(prisma, workspaceId, {
        aiTests: 3, limit: 20,
      }, afterMidnight);
      assert.equal(november.ok, true);
      const octoberAgain = await prisma.usagePeriod.findUniqueOrThrow({
        where: { id: october.id },
      });
      assert.equal(octoberAgain.aiTests, 9);
      assert.equal(octoberAgain.aiTestsReserved, 0);
      const novemberPeriod = await prisma.usagePeriod.findUniqueOrThrow({
        where: { workspaceId_periodStart: {
          workspaceId, periodStart: new Date("2026-11-01T00:00:00.000Z"),
        } },
      });
      assert.equal(novemberPeriod.aiTests, 0);
      assert.equal(novemberPeriod.aiTestsReserved, 3);
      await releaseUsage(prisma, workspaceId, {
        reservedAiTests: 3,
      }, afterMidnight);
    } finally { await cleanup(workspaceId); }
  });

  it("mixed-mode legacy settlement and ledger release leave no phantom holds", async () => {
    const workspaceId = await setup();
    const operationId = randomUUID();
    try {
      const [legacy, ledger] = await Promise.all([
        reserveUsage(prisma, workspaceId, { aiTests: 7, limit: 20 }),
        reserveVisibilityOperation(prisma, {
          operationId, workspaceId, aiTests: 7, limit: 20, now: new Date(),
        }),
      ]);
      assert.equal(legacy.ok, true);
      assert.equal(ledger.status, "reserved");
      assert.equal((await period(workspaceId)).aiTestsReserved, 14);
      const [legacyCommitted, ledgerReleased] = await Promise.all([
        commitUsage(prisma, workspaceId, {
          reservedAiTests: 7, actualAiTests: 5,
        }),
        releaseVisibilityOperation(prisma, { operationId, workspaceId }),
      ]);
      assert.ok(legacyCommitted);
      assert.equal(ledgerReleased.status, "released");
      const usage = await period(workspaceId);
      assert.equal(usage.aiTests, 5);
      assert.equal(usage.aiTestsReserved, 0);
      assert.equal((await releaseVisibilityOperation(prisma, {
        operationId, workspaceId,
      })).status, "released");
      assert.equal((await settleVisibilityOperation(prisma, {
        operationId, workspaceId, actualAiTests: 7,
      })).status, "already_released");
      const after = await period(workspaceId);
      assert.equal(after.aiTests, 5);
      assert.equal(after.aiTestsReserved, 0);
    } finally { await cleanup(workspaceId); }
  });

  it("rollback to legacy reservations preserves committed ledger usage", async () => {
    const workspaceId = await setup();
    const operationId = randomUUID();
    try {
      const ledger = await reserveVisibilityOperation(prisma, {
        operationId, workspaceId, aiTests: 7, limit: 10, now: new Date(),
      });
      assert.equal(ledger.status, "reserved");
      assert.equal((await settleVisibilityOperation(prisma, {
        operationId, workspaceId, actualAiTests: 6,
      })).status, "committed");
      const beforeRollback = await period(workspaceId);
      assert.equal(beforeRollback.aiTests, 6);
      assert.equal(beforeRollback.aiTestsReserved, 0);
      // Simulate disabling the new adapter for subsequent requests.
      const rejected = await reserveUsage(prisma, workspaceId, {
        aiTests: 5, limit: 10,
      });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.reason, "insufficient_allowance");
      const admitted = await reserveUsage(prisma, workspaceId, {
        aiTests: 4, limit: 10,
      });
      assert.equal(admitted.ok, true);
      await commitUsage(prisma, workspaceId, {
        reservedAiTests: 4, actualAiTests: 3,
      });
      const afterRollback = await period(workspaceId);
      assert.equal(afterRollback.aiTests, 9);
      assert.equal(afterRollback.aiTestsReserved, 0);
      assert.equal((await settleVisibilityOperation(prisma, {
        operationId, workspaceId, actualAiTests: 6,
      })).status, "already_committed");
      assert.equal((await period(workspaceId)).aiTests, 9);
    } finally { await cleanup(workspaceId); }
  });

  it("recovery HOLD audit rejects explicit release and settle decisions", async () => {
    const workspaceId = await setup();
    const operationId = randomUUID();
    try {
      assert.equal((await reserveVisibilityOperation(prisma, {
        operationId, workspaceId, aiTests: 2, limit: 10, now: new Date(),
      })).status, "reserved");
      for (const decision of ["release", "settle"]) {
        await assert.rejects(
          recordVisibilityRecoveryHold(prisma, {
            operationId, workspaceId, reviewerId: "reviewer-test",
            decision, evidence: ["incident:REC-1"], reason: "Verify provider usage",
          }),
          /not enabled/,
        );
      }
      const reviews = await prisma.visibilityRecoveryReview.count({
        where: { operationId, workspaceId },
      });
      assert.equal(reviews, 0);
      const usage = await period(workspaceId);
      assert.equal(usage.aiTests, 0);
      assert.equal(usage.aiTestsReserved, 2);
    } finally { await cleanup(workspaceId); }
  });
});
