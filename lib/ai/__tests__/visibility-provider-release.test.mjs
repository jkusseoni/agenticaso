import test from "node:test";
import assert from "node:assert/strict";
import { runVisibilityAuditV2 } from "../visibility-v2.js";

test("provider failure releases reservation without committing usage", async () => {
  const calls = [];

  const input = {
    url: "https://example.com",
    brand: "Example",
    question: "What does Example sell?",
    clerkUserId: "test-user",
    workspace: { id: "test-workspace", clerkUserId: "test-user" },
    prisma: {
      workspace: {
        findFirst: async ({ where }) =>
          where.id === "test-workspace" &&
          where.clerkUserId === "test-user"
            ? { id: "test-workspace" }
            : null,
      },
      website: {
        findUnique: async () => ({ id: "site-test-1" }),
      },
    },
    entitlements: {
      planId: "pro",
      entitlements: {
        websites: 3,
        buyerQuestions: 50,
        aiTestsPerMonth: 3000,
        advancedCompetitors: true,
      },
    },
    usage: { aiTests: 0, audits: 0 },
  };

  const deps = {
    siteSignals: async () => ({
      ok: true,
      title: "Example",
      desc: "Example products",
      bodyText: "Example products and services",
    }),

    runAllProviders: async () => {
      calls.push("provider-failed");
      throw new Error("Simulated provider outage");
    },

    reserveUsageOperation: async (_db, _id, args) => {
      calls.push("reserve");
      return {
        ok: true,
        operationId: "failure-operation-1",
        reserved: args.aiTests,
      };
    },

    releaseUsageOperation: async (_db, _id, args) => {
      calls.push("release");
      assert.equal(args.operationId, "failure-operation-1");
      return { settled: true };
    },

    commitUsageOperation: async () => {
      calls.push("commit");
      throw new Error("Commit must not run");
    },

    persistCompletedAudit: async () => {
      calls.push("persist");
      throw new Error("Persistence must not run");
    },

    getPreviousCompletedAudit: async () => null,
  };

  const result = await runVisibilityAuditV2(input, deps);

  assert.equal(result.ok, false);
  assert.equal(result.status, 500);

  assert.deepEqual(calls, [
    "reserve",
    "provider-failed",
    "release",
  ]);
});
