import {
  getPrisma,
  isDatabaseConfigured,
  assertDb,
} from "@/lib/db";
import { requireClerkUser, mapDbError } from "@/lib/db/auth-gate";
import { isValidFrequency, computeNextRunAt, executeMonitoringRun } from "@/lib/monitoring";
import { rateLimited } from "@/lib/api/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

async function getOwnedMonitoring(db, id, clerkUserId) {
  const monitoring = await db.monitoring.findFirst({
    where: {
      id,
      website: { workspace: { clerkUserId } },
    },
    include: {
      website: { include: { workspace: { include: { subscription: true } } } },
    },
  });
  if (!monitoring) {
    const err = new Error("Monitoring not found.");
    err.code = "NOT_FOUND";
    throw err;
  }
  return monitoring;
}

/**
 * PATCH /api/monitoring/:id
 * Body: { active?, frequency?, action?: "pause"|"resume"|"run_now" }
 * Run Now uses the same executeMonitoringRun path as cron (entitlement + reservation).
 */
export async function PATCH(req, ctx) {
  try {
    const gate = await requireClerkUser({ withBilling: true });
    if (!gate.ok) return gate.response;
    if (!gate.isPaid) {
      return Response.json(
        {
          upgrade: true,
          code: "ENTITLEMENT_REQUIRED",
          feature: "monitoring",
          message: "Monitoring is a Pro feature. Unlock weekly monitoring with Pro.",
          suggestedPlan: "pro",
        },
        { status: 402 }
      );
    }
    if (!isDatabaseConfigured()) {
      return Response.json({ error: "Database is not configured yet." }, { status: 503 });
    }

    const { id } = await ctx.params;
    if (!id) return Response.json({ error: "Missing monitoring id." }, { status: 422 });

    const body = await req.json().catch(() => ({}));
    const db = assertDb(getPrisma());
    const existing = await getOwnedMonitoring(db, id, gate.userId);

    if (body.action === "run_now") {
      if (rateLimited(`${gate.userId}:monitoring:run_now`, 10)) {
        return Response.json({ error: "Rate limit hit — try later." }, { status: 429 });
      }
      if (!existing.active) {
        return Response.json({ error: "Monitoring is paused. Resume before Run Now." }, { status: 422 });
      }

      const result = await executeMonitoringRun(db, existing, {
        manual: true,
      });

      if (result.status === "already_running") {
        return Response.json(
          { error: result.reason, status: "already_running", monitoring: shape(existing) },
          { status: 409 }
        );
      }
      if (result.status === "skipped_entitlement" || result.status === "skipped_usage") {
        return Response.json(
          {
            ...(result.upgrade || {}),
            error: result.reason,
            status: result.status,
            upgrade: true,
          },
          { status: 402 }
        );
      }

      const refreshed = await getOwnedMonitoring(db, id, gate.userId);
      return Response.json({ monitoring: shape(refreshed), run: result });
    }

    const data = {};
    if (body.action === "pause" || body.active === false) data.active = false;
    if (body.action === "resume" || body.active === true) {
      data.active = true;
      if (!existing.nextRunAt || new Date(existing.nextRunAt) < new Date()) {
        data.nextRunAt = computeNextRunAt(existing.frequency);
      }
    }
    if (body.frequency != null) {
      const frequency = String(body.frequency).toLowerCase();
      if (!isValidFrequency(frequency)) {
        return Response.json({ error: "frequency must be weekly or monthly." }, { status: 422 });
      }
      data.frequency = frequency;
      data.nextRunAt = computeNextRunAt(frequency);
    }

    const monitoring = await db.monitoring.update({
      where: { id },
      data,
      include: { website: { select: { id: true, domain: true, brandName: true, url: true } } },
    });

    return Response.json({ monitoring });
  } catch (e) {
    return mapDbError(e);
  }
}

/**
 * DELETE /api/monitoring/:id
 */
export async function DELETE(_req, ctx) {
  try {
    const gate = await requireClerkUser({ withBilling: true });
    if (!gate.ok) return gate.response;
    if (!isDatabaseConfigured()) {
      return Response.json({ error: "Database is not configured yet." }, { status: 503 });
    }

    const { id } = await ctx.params;
    if (!id) return Response.json({ error: "Missing monitoring id." }, { status: 422 });

    const db = assertDb(getPrisma());
    await getOwnedMonitoring(db, id, gate.userId);
    await db.monitoring.delete({ where: { id } });
    return Response.json({ ok: true });
  } catch (e) {
    return mapDbError(e);
  }
}

function shape(m) {
  return {
    id: m.id,
    websiteId: m.websiteId,
    website: m.website
      ? { id: m.website.id, domain: m.website.domain, brandName: m.website.brandName, url: m.website.url }
      : undefined,
    frequency: m.frequency,
    active: m.active,
    nextRunAt: m.nextRunAt,
    lastRunAt: m.lastRunAt,
    lastStatus: m.lastStatus,
    lastError: m.lastError,
  };
}
