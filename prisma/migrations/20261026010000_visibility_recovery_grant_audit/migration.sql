-- Record manual recovery grant changes without modifying existing review history.
CREATE TABLE "VisibilityRecoveryGrantAudit" (
  "id" TEXT NOT NULL,
  "targetActorId" TEXT NOT NULL,
  "operatorId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "beforeState" JSONB,
  "afterState" JSONB NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VisibilityRecoveryGrantAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VisibilityRecoveryGrantAudit_action_check"
    CHECK ("action" IN ('grant', 'revoke')),
  CONSTRAINT "VisibilityRecoveryGrantAudit_identity_check"
    CHECK (length(btrim("targetActorId")) > 0 AND length(btrim("operatorId")) > 0 AND length(btrim("reason")) > 0)
);
CREATE INDEX "VisibilityRecoveryGrantAudit_targetActorId_createdAt_idx"
  ON "VisibilityRecoveryGrantAudit"("targetActorId", "createdAt");
CREATE INDEX "VisibilityRecoveryGrantAudit_operatorId_createdAt_idx"
  ON "VisibilityRecoveryGrantAudit"("operatorId", "createdAt");
CREATE OR REPLACE FUNCTION reject_visibility_recovery_grant_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'VisibilityRecoveryGrantAudit records are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "VisibilityRecoveryGrantAudit_immutable"
BEFORE UPDATE OR DELETE ON "VisibilityRecoveryGrantAudit"
FOR EACH ROW EXECUTE FUNCTION reject_visibility_recovery_grant_audit_mutation();
