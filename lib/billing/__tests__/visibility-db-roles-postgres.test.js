import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, it } from "node:test";

const url = process.env.VISIBILITY_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration("recovery audit restricted PostgreSQL role", () => {
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  it("denies audit mutations and schema changes to a separate runtime role", async () => {
    const role = `ci_recovery_runtime_${randomUUID().replaceAll("-", "")}`;
    const quoted = `"${role}"`;
    let created = false;
    try {
      await prisma.$executeRawUnsafe(`CREATE ROLE ${quoted} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
      created = true;
      await prisma.$executeRawUnsafe(
        `GRANT USAGE ON SCHEMA public TO ${quoted}`
      );
      await prisma.$executeRawUnsafe(
        `GRANT SELECT, INSERT ON TABLE "VisibilityRecoveryGrantAudit", "VisibilityRecoveryReview" TO ${quoted}`
      );

      const [privileges] = await prisma.$queryRawUnsafe(
        `SELECT
          has_table_privilege($1, 'public."VisibilityRecoveryGrantAudit"', 'INSERT') AS grant_insert,
          has_table_privilege($1, 'public."VisibilityRecoveryGrantAudit"', 'UPDATE') AS grant_update,
          has_table_privilege($1, 'public."VisibilityRecoveryGrantAudit"', 'DELETE') AS grant_delete,
          has_table_privilege($1, 'public."VisibilityRecoveryReview"', 'INSERT') AS review_insert,
          has_table_privilege($1, 'public."VisibilityRecoveryReview"', 'UPDATE') AS review_update,
          has_table_privilege($1, 'public."VisibilityRecoveryReview"', 'DELETE') AS review_delete`,
        role
      );
      assert.equal(privileges.grant_insert, true);
      assert.equal(privileges.review_insert, true);
      for (const key of ["grant_update", "grant_delete", "review_update", "review_delete"]) {
        assert.equal(privileges[key], false, `${key} must be denied`);
      }

      // SET LOCAL ROLE ensures each attempt uses the restricted identity, not the owner.
      const denied = async (sql) => {
        await assert.rejects(prisma.$transaction(async tx => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${quoted}`);
          await tx.$executeRawUnsafe(sql);
        }));
      };
      await denied(`UPDATE "VisibilityRecoveryGrantAudit" SET "reason" = 'tampered' WHERE false`);
      await denied(`DELETE FROM "VisibilityRecoveryGrantAudit" WHERE false`);
      await denied(`UPDATE "VisibilityRecoveryReview" SET "reason" = 'tampered' WHERE false`);
      await denied(`DELETE FROM "VisibilityRecoveryReview" WHERE false`);
      await denied(`ALTER TABLE "VisibilityRecoveryGrantAudit" DISABLE TRIGGER "VisibilityRecoveryGrantAudit_immutable"`);
      await denied(`ALTER TABLE "VisibilityRecoveryReview" ADD COLUMN "ci_forbidden" TEXT`);
    } finally {
      if (created) {
        await prisma.$executeRawUnsafe(`REVOKE ALL PRIVILEGES ON TABLE "VisibilityRecoveryGrantAudit", "VisibilityRecoveryReview" FROM ${quoted}`);
        await prisma.$executeRawUnsafe(`REVOKE USAGE ON SCHEMA public FROM ${quoted}`);
        await prisma.$executeRawUnsafe(`DROP ROLE ${quoted}`);
      }
      await prisma.$disconnect();
    }
  });
});
