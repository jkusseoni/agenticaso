-- Preserve recovery review evidence if a parent operation or workspace
-- is deleted. Parent deletion must be handled by an explicit retention policy.
ALTER TABLE "VisibilityRecoveryReview"
  DROP CONSTRAINT "VisibilityRecoveryReview_operationId_fkey";
ALTER TABLE "VisibilityRecoveryReview"
  ADD CONSTRAINT "VisibilityRecoveryReview_operationId_fkey"
  FOREIGN KEY ("operationId") REFERENCES "VisibilityUsageOperation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VisibilityRecoveryReview"
  DROP CONSTRAINT "VisibilityRecoveryReview_workspaceId_fkey";
ALTER TABLE "VisibilityRecoveryReview"
  ADD CONSTRAINT "VisibilityRecoveryReview_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
