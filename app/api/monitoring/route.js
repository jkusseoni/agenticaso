import {
  getPrisma,
  isDatabaseConfigured,
  assertDb,
  assertWebsiteOwnership,
} from "@/lib/db";
import { requireClerkUser, mapDbError } from "@/lib/db/auth-gate";
import { isValidFrequency, computeNextRunAt } from "@/lib/monitoring";
import { checkMonitoringSlots } from "@/lib/billing";

export const runtime = "nodejs";

/**
 * GET /api/monitoring — list monitors for the signed-in user
 */
export async function GET() {
  try {
    const gate = await requireClerkUser();
    if (!gate.ok) return gate.response;
    if (!isDatabaseConfigured()) {
      return Response.json({ error: "Database is not configured yet.", monitorings: [] }, { status: 503 });
    }

    const db = assertDb(getPrisma());
    const monitorings = await db.monitoring.findMany({
      where: { website: { workspace: { clerkUserId: gate.userId } } },
      orderBy: { updatedAt: "desc" },
      include: {
        website: { select: { id: true, domain: true, brandName: true, url: true } },
      },
    });

    return Response.json({ monitorings });
  } catch (e) {
    return mapDbError(e);
  }
}

/**
 * POST /api/monitoring — create/upsert monitoring for an owned website
 * Body: { websiteId, frequency?: "weekly"|"monthly" }
 */
export async function POST(req) {
  try {
    const gate = await requireClerkUser({ withBilling: true });
    if (!gate.ok) return gate.response;
    if (!isDatabaseConfigured()) {
      return Response.json({ error: "Database is not configured yet." }, { status: 503 });
    }

    const body = await req.json().catch(() => ({}));
    const websiteId = String(body.websiteId || "").trim();
    const frequency = String(body.frequency || "weekly").toLowerCase();
    if (!websiteId) return Response.json({ error: "websiteId is required." }, { status: 422 });
    if (!isValidFrequency(frequency)) {
      return Response.json({ error: "frequency must be weekly or monthly." }, { status: 422 });
    }

    const db = assertDb(getPrisma());
    await assertWebsiteOwnership(db, { websiteId, clerkUserId: gate.userId });

    const existing = await db.monitoring.findUnique({ where: { websiteId } });
    if (!existing) {
      const activeCount = await db.monitoring.count({
        where: { website: { workspace: { clerkUserId: gate.userId } }, active: true },
      });
      const slots = checkMonitoringSlots({
        entitlements: gate.entitlements,
        activeMonitoringCount: activeCount,
      });
      if (!slots.ok) return slots.response;
    }

    const monitoring = await db.monitoring.upsert({
      where: { websiteId },
      create: {
        websiteId,
        frequency,
        active: true,
        nextRunAt: computeNextRunAt(frequency),
      },
      update: {
        frequency,
        active: true,
        nextRunAt: computeNextRunAt(frequency),
        lastError: null,
      },
      include: {
        website: { select: { id: true, domain: true, brandName: true, url: true } },
      },
    });

    return Response.json({ monitoring });
  } catch (e) {
    return mapDbError(e);
  }
}
