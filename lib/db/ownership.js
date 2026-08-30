/**
 * Workspace / website ownership — identity always from Clerk server-side.
 */

/**
 * @param {import("@prisma/client").PrismaClient} db
 * @param {{ clerkUserId: string, email?: string|null }} opts
 */
export async function getOrCreateWorkspace(db, { clerkUserId, email = null }) {
  if (!clerkUserId) {
    const err = new Error("Missing Clerk user id.");
    err.code = "UNAUTHORIZED";
    throw err;
  }

  return db.workspace.upsert({
    where: { clerkUserId },
    create: { clerkUserId, email: email || null },
    update: email ? { email } : {},
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} db
 * @param {{ workspaceId: string, domain: string, url: string, brandName?: string, category?: string }} opts
 */
export async function getOrCreateWebsite(db, { workspaceId, domain, url, brandName, category }) {
  const existing = await db.website.findUnique({
    where: { workspaceId_domain: { workspaceId, domain } },
  });
  if (existing) {
    return db.website.update({
      where: { id: existing.id },
      data: {
        url: url || existing.url,
        brandName: brandName || existing.brandName,
        category: category || existing.category,
      },
    });
  }
  return db.website.create({
    data: {
      workspaceId,
      domain,
      url,
      brandName: brandName || null,
      category: category || null,
    },
  });
}

/**
 * Ensure the website belongs to the Clerk user's workspace.
 * @param {import("@prisma/client").PrismaClient} db
 * @param {{ websiteId: string, clerkUserId: string }} opts
 */
export async function assertWebsiteOwnership(db, { websiteId, clerkUserId }) {
  const website = await db.website.findFirst({
    where: {
      id: websiteId,
      workspace: { clerkUserId },
    },
    include: { workspace: true },
  });
  if (!website) {
    const err = new Error("Website not found.");
    err.code = "NOT_FOUND";
    throw err;
  }
  return website;
}

/**
 * Ensure the audit belongs to the Clerk user.
 * @param {import("@prisma/client").PrismaClient} db
 * @param {{ auditId: string, clerkUserId: string }} opts
 */
export async function assertAuditOwnership(db, { auditId, clerkUserId }) {
  const audit = await db.audit.findFirst({
    where: {
      id: auditId,
      website: { workspace: { clerkUserId } },
    },
    include: {
      website: true,
      aiTests: true,
      competitors: true,
      perception: true,
      questions: { include: { question: true }, orderBy: { sortOrder: "asc" } },
    },
  });
  if (!audit) {
    const err = new Error("Audit not found.");
    err.code = "NOT_FOUND";
    throw err;
  }
  return audit;
}
