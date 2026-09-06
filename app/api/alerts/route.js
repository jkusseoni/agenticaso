import { getPrisma, isDatabaseConfigured, assertDb } from "@/lib/db";
import { requireClerkUser, mapDbError } from "@/lib/db/auth-gate";

export const runtime = "nodejs";

/**
 * GET /api/alerts?websiteId=&unread=1&limit=
 */
export async function GET(req) {
  try {
    const gate = await requireClerkUser();
    if (!gate.ok) return gate.response;
    if (!isDatabaseConfigured()) {
      return Response.json({ error: "Database is not configured yet.", alerts: [] }, { status: 503 });
    }

    const db = assertDb(getPrisma());
    const url = new URL(req.url);
    const websiteId = url.searchParams.get("websiteId") || undefined;
    const unread = url.searchParams.get("unread") === "1";
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20)));

    const alerts = await db.alert.findMany({
      where: {
        website: { workspace: { clerkUserId: gate.userId } },
        ...(websiteId ? { websiteId } : {}),
        ...(unread ? { read: false } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        website: { select: { id: true, domain: true, brandName: true } },
      },
    });

    return Response.json({ alerts });
  } catch (e) {
    return mapDbError(e);
  }
}

/**
 * PATCH /api/alerts — mark read
 * Body: { ids?: string[], all?: boolean, websiteId?: string }
 */
export async function PATCH(req) {
  try {
    const gate = await requireClerkUser();
    if (!gate.ok) return gate.response;
    if (!isDatabaseConfigured()) {
      return Response.json({ error: "Database is not configured yet." }, { status: 503 });
    }

    const body = await req.json().catch(() => ({}));
    const db = assertDb(getPrisma());

    if (body.all) {
      await db.alert.updateMany({
        where: {
          website: { workspace: { clerkUserId: gate.userId } },
          read: false,
          ...(body.websiteId ? { websiteId: String(body.websiteId) } : {}),
        },
        data: { read: true },
      });
      return Response.json({ ok: true });
    }

    const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
    if (!ids.length) return Response.json({ error: "Send { ids } or { all: true }." }, { status: 422 });

    await db.alert.updateMany({
      where: {
        id: { in: ids },
        website: { workspace: { clerkUserId: gate.userId } },
      },
      data: { read: true },
    });

    return Response.json({ ok: true });
  } catch (e) {
    return mapDbError(e);
  }
}
