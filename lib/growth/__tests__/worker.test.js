import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createFakePrisma } from "./fake-growth-db.js";
import {
  runGrowthWorker,
  resolveGrowthWorkerLimit,
  GROWTH_WORKER_BATCH_HARD_MAX,
  GROWTH_WORKER_BATCH_DEFAULT,
} from "../worker.js";
import { handleGrowthInternalRun } from "../internal-run.js";
import { safeSecretEqual } from "../../security/secrets.js";

function envBase(extra = {}) {
  return {
    GROWTH_AGENT_ENABLED: "true",
    CRON_SECRET: "cron-secret-value",
    ...extra,
  };
}

async function seedDueJob(db, { status = "active", workspaceId = "ws1", lifecycle = "research_pending", jobStatus = "pending", leaseExpiresAt = null } = {}) {
  const c = db.seed.campaign({ status, workspaceId });
  const p = db.seed.prospect(c);
  p.lifecycleState = lifecycle;
  const job = await db.seed.job(c, p, "research", { status: jobStatus, leaseExpiresAt, availableAt: new Date(Date.now() - 1000) });
  return { c, p, job };
}

describe("growth worker limits", () => {
  it("caps batch at the hard maximum", () => {
    assert.equal(resolveGrowthWorkerLimit(99), GROWTH_WORKER_BATCH_HARD_MAX);
    assert.equal(resolveGrowthWorkerLimit("nope"), GROWTH_WORKER_BATCH_DEFAULT);
  });

  it("compares secrets in constant time", () => {
    assert.equal(safeSecretEqual("abc", "abc"), true);
    assert.equal(safeSecretEqual("abc", "xyz"), false);
    assert.equal(safeSecretEqual("", "abc"), false);
  });
});

describe("growth internal route auth", () => {
  it("missing secret → 401", async () => {
    const res = await handleGrowthInternalRun(new Request("https://x.test/api/internal/growth/run", { method: "POST" }), {
      env: { GROWTH_AGENT_ENABLED: "true" },
      getDb: () => ({}),
      run: async () => ({ enabled: true, results: [] }),
    });
    assert.equal(res.status, 401);
  });

  it("wrong secret → 401", async () => {
    const res = await handleGrowthInternalRun(
      new Request("https://x.test/api/internal/growth/run", {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      }),
      {
        env: envBase(),
        getDb: () => ({}),
        run: async () => ({ enabled: true, results: [] }),
      }
    );
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized.");
    assert.equal(/cron-secret-value/.test(JSON.stringify(body)), false);
  });

  it("feature disabled → zero work", async () => {
    let ran = 0;
    const res = await handleGrowthInternalRun(
      new Request("https://x.test/api/internal/growth/run", {
        method: "POST",
        headers: { authorization: "Bearer cron-secret-value" },
      }),
      {
        env: envBase({ GROWTH_AGENT_ENABLED: "false" }),
        getDb: () => {
          throw new Error("db should not be used");
        },
        run: async () => {
          ran += 1;
          return { enabled: true };
        },
      }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enabled, false);
    assert.equal(body.claimed, 0);
    assert.equal(ran, 0);
  });
});

describe("growth worker execution gates", () => {
  it("enabled + valid secret → bounded execution", async () => {
    const db = createFakePrisma();
    await seedDueJob(db);
    const calls = [];
    const result = await runGrowthWorker(db, {
      env: envBase(),
      processJob: async ({ jobId, alreadyClaimed }) => {
        calls.push({ jobId, alreadyClaimed });
        return { status: "succeeded" };
      },
    });
    assert.equal(result.enabled, true);
    assert.equal(result.claimed, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].alreadyClaimed, true);
  });

  it("batch cannot exceed hard maximum", async () => {
    const db = createFakePrisma();
    for (let i = 0; i < 8; i += 1) await seedDueJob(db, { workspaceId: `ws${i}` });
    const calls = [];
    const result = await runGrowthWorker(db, {
      env: envBase({ GROWTH_WORKER_LIMIT: "99" }),
      limit: 99,
      processJob: async ({ jobId }) => {
        calls.push(jobId);
        return { status: "succeeded" };
      },
    });
    assert.equal(calls.length, GROWTH_WORKER_BATCH_HARD_MAX);
    assert.equal(result.claimed, GROWTH_WORKER_BATCH_HARD_MAX);
  });

  it("paused campaign skipped", async () => {
    const db = createFakePrisma();
    await seedDueJob(db, { status: "paused" });
    const result = await runGrowthWorker(db, {
      env: envBase(),
      processJob: async () => ({ status: "succeeded" }),
    });
    assert.equal(result.claimed, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.results[0].skip, "campaign_paused");
  });

  it("draft campaign skipped", async () => {
    const db = createFakePrisma();
    await seedDueJob(db, { status: "draft" });
    const result = await runGrowthWorker(db, {
      env: envBase(),
      processJob: async () => ({ status: "succeeded" }),
    });
    assert.equal(result.claimed, 0);
    assert.equal(result.results[0].skip, "campaign_draft");
  });

  it("archived/completed campaign skipped", async () => {
    const db = createFakePrisma();
    await seedDueJob(db, { status: "archived" });
    await seedDueJob(db, { status: "completed", workspaceId: "ws2" });
    const result = await runGrowthWorker(db, {
      env: envBase(),
      processJob: async () => ({ status: "succeeded" }),
    });
    assert.equal(result.claimed, 0);
    assert.equal(result.skipped, 2);
  });

  it("allowlisted workspace executes", async () => {
    const db = createFakePrisma();
    await seedDueJob(db, { workspaceId: "allow-me" });
    const result = await runGrowthWorker(db, {
      env: envBase({ GROWTH_WORKSPACE_ALLOWLIST: "allow-me" }),
      processJob: async () => ({ status: "succeeded" }),
    });
    assert.equal(result.claimed, 1);
  });

  it("non-allowlisted workspace skipped", async () => {
    const db = createFakePrisma();
    await seedDueJob(db, { workspaceId: "other" });
    const result = await runGrowthWorker(db, {
      env: envBase({ GROWTH_WORKSPACE_ALLOWLIST: "allow-me" }),
      processJob: async () => ({ status: "succeeded" }),
    });
    assert.equal(result.claimed, 0);
    assert.equal(result.results[0].skip, "workspace_not_allowlisted");
    assert.equal(db.state.jobs[0].status, "pending");
  });

  it("selector does not substitute for atomic claim", async () => {
    const db = createFakePrisma();
    const { job } = await seedDueJob(db);
    await db.growthJob.update({
      where: { id: job.id },
      data: { status: "running", leaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    const result = await runGrowthWorker(db, {
      env: envBase(),
      processJob: async () => ({ status: "succeeded" }),
    });
    assert.equal(result.claimed, 0);
  });

  it("two worker invocations cannot execute same job concurrently", async () => {
    const db = createFakePrisma();
    await seedDueJob(db);
    const started = [];
    const processJob = async ({ jobId }) => {
      started.push(jobId);
      await new Promise((r) => setTimeout(r, 20));
      return { status: "succeeded" };
    };
    const [a, b] = await Promise.all([
      runGrowthWorker(db, { env: envBase(), processJob }),
      runGrowthWorker(db, { env: envBase(), processJob }),
    ]);
    assert.equal(started.length, 1);
    assert.equal(a.claimed + b.claimed, 1);
  });

  it("expired lease reclaim works", async () => {
    const db = createFakePrisma();
    await seedDueJob(db, {
      jobStatus: "running",
      leaseExpiresAt: new Date(Date.now() - 1000),
    });
    const result = await runGrowthWorker(db, {
      env: envBase(),
      processJob: async () => ({ status: "succeeded" }),
    });
    assert.equal(result.claimed, 1);
  });

  it("unexpired lease does not reclaim", async () => {
    const db = createFakePrisma();
    await seedDueJob(db, {
      jobStatus: "running",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const result = await runGrowthWorker(db, {
      env: envBase(),
      processJob: async () => ({ status: "succeeded" }),
    });
    assert.equal(result.claimed, 0);
  });

  it("terminal prospect stale job skipped", async () => {
    const db = createFakePrisma();
    await seedDueJob(db, { lifecycle: "qualified" });
    const result = await runGrowthWorker(db, {
      env: envBase(),
      processJob: async () => ({ status: "succeeded" }),
    });
    assert.equal(result.claimed, 0);
    assert.equal(result.results[0].skip, "terminal_prospect");
    assert.equal(db.state.jobs[0].status, "pending");
  });

  it("worker stops when wall-clock budget is low", async () => {
    const db = createFakePrisma();
    await seedDueJob(db);
    await seedDueJob(db, { workspaceId: "ws2" });
    const start = 1_000_000;
    let calls = 0;
    const result = await runGrowthWorker(db, {
      env: envBase(),
      startedAt: start,
      budgetMs: 4_000,
      aiTimeoutMs: 25_000,
      clock: () => start + 100,
      processJob: async () => {
        calls += 1;
        return { status: "succeeded" };
      },
    });
    assert.equal(calls, 0);
    assert.ok(result.timedOut >= 1);
  });

  it("worker does not leak provider errors/secrets", async () => {
    const db = createFakePrisma();
    await seedDueJob(db);
    const result = await runGrowthWorker(db, {
      env: envBase(),
      processJob: async () => ({
        status: "failed",
        errorCode: "CRITIC_TIMEOUT",
        error: "Bearer sk-live-secret AICREDITS_API_KEY=abc <html>nope</html>",
      }),
    });
    const blob = JSON.stringify(result);
    assert.equal(/sk-live-secret/.test(blob), false);
    assert.equal(/AICREDITS_API_KEY/.test(blob), false);
    assert.equal(/<!DOCTYPE|<html/i.test(blob), false);
  });

  it("worker response contains no HTML", async () => {
    const res = await handleGrowthInternalRun(
      new Request("https://x.test/api/internal/growth/run", {
        method: "POST",
        headers: { authorization: "Bearer cron-secret-value" },
      }),
      {
        env: envBase(),
        getDb: () => createFakePrisma(),
        run: async () => ({
          enabled: true,
          examined: 1,
          claimed: 0,
          succeeded: 0,
          failed: 0,
          skipped: 0,
          timedOut: 0,
          results: [{ jobId: "j1", type: "research", status: "skipped", html: "<html>secret</html>" }],
        }),
      }
    );
    const text = await res.text();
    assert.equal(/<html/i.test(text), false);
  });

  it("worker does not discover prospects", async () => {
    const db = createFakePrisma();
    const before = db.state.prospects.length;
    await runGrowthWorker(db, {
      env: envBase(),
      processJob: async () => ({ status: "succeeded" }),
    });
    assert.equal(db.state.prospects.length, before);
  });

  it("worker does not send outreach", async () => {
    const src = fs.readFileSync(path.join(process.cwd(), "lib/growth/worker.js"), "utf8");
    assert.equal(/\b(gmail|linkedin|sendEmail|resend\.emails)\b/i.test(src), false);
    const route = fs.readFileSync(path.join(process.cwd(), "lib/growth/internal-run.js"), "utf8");
    assert.equal(/\b(gmail|linkedin|sendEmail|resend\.emails)\b/i.test(route), false);
    const vercel = fs.readFileSync(path.join(process.cwd(), "vercel.json"), "utf8");
    assert.equal(/internal\/growth/.test(vercel), false);
  });
});
