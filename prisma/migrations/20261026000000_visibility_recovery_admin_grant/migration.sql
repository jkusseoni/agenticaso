-- Manual recovery reviewer grants are provisioned by trusted server operators only.
-- No initial admin grants or privileges are inserted by this migration.
CREATE TABLE "VisibilityRecoveryAdminGrant" (
  "actorId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "workspaceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VisibilityRecoveryAdminGrant_pkey" PRIMARY KEY ("actorId"),
  CONSTRAINT "VisibilityRecoveryAdminGrant_actor_nonblank_check"
    CHECK (length(btrim("actorId")) > 0)
);
