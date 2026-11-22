import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const gap = { calls: [] };
globalThis.__monitoringBudgetGap = gap;

function dataModule(source) {
  return {
    url: "data:text/javascript," + encodeURIComponent(source),
    shortCircuit: true,
  };
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL || "";
    if (!parent.includes("/lib/monitoring/run.js")) return nextResolve(specifier, context);
    if (specifier === "../ai/audit.js") {
      return dataModule(`
        export async function runMultiAiAudit() {
          globalThis.__monitoringBudgetGap.calls.push("audit");
          const error = new Error("scan_budget_exceeded");
          error.code = "scan_budget_exceeded";
          throw error;
        }
      `);
    }
    if (specifier === "../billing/monitoring-prepare.js") {
      return dataModule(`
        export async function prepareMonitoringUsage() {
          globalThis.__monitoringBudgetGap.calls.push("prepare");
          return {
            ok: true,
            expectedAiTests: 3,
            reserved: 3,
            questions: [{ id: "q1", question: "best goods", category: "" }],
            workspaceId: "ws-1",
          };
        }
      `);
    }
    if (specifier === "../db/persist.js") {
      return dataModule(`
        export async function persistCompletedAudit() {
          globalThis.__monitoringBudgetGap.calls.push("persist");
          throw new Error("persist must not run");
        }
        export async function getPreviousCompletedAudit() {
          return null;
        }
      `);
    }
    return nextResolve(specifier, context);
  },
});

const { executeMonitoringRun } = await import("../../monitoring/run.js");

test("monitoring marks the run failed and releases usage when the audit hits a budget error", async () => {
  gap.calls = [];
  const updates = [];
  const period = { id: "period-1", aiTests: 0, aiTestsReserved: 3, audits: 0, monitoringRuns: 0 };
  const db = {
    monitoring: {
      updateMany: async () => {
        gap.calls.push("claim");
        return { count: 1 };
      },
      update: async ({ data }) => {
        updates.push(data);
        gap.calls.push("finish");
        return data;
      },
      findUnique: async () => null,
    },
    alert: {
      create: async () => {
        gap.calls.push("alert");
      },
    },
    usagePeriod: {
      upsert: async () => {
        gap.calls.push("usage-read");
        return period;
      },
      findUnique: async () => period,
    },
    $executeRaw: async () => {
      gap.calls.push("usage-release");
      return 1;
    },
  };

  const result = await executeMonitoringRun(db, {
    id: "mon-1",
    frequency: "weekly",
    website: {
      id: "site-1",
      domain: "example.com",
      url: "https://example.com",
      brandName: "Example",
      workspace: { id: "ws-1", clerkUserId: "user-1", subscription: { id: "sub-1" } },
    },
  }, { manual: true, scheduleKey: "manual:test" });

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "scan_budget_exceeded");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].lastStatus, "failed");
  assert.equal(updates[0].lastError, "scan_budget_exceeded");
  assert.deepEqual(gap.calls, ["prepare", "claim", "audit", "usage-read", "usage-release", "finish"]);
  assert.equal(gap.calls.includes("persist"), false);
  assert.equal(gap.calls.includes("alert"), false);
});
