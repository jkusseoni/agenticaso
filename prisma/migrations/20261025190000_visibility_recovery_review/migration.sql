CREATE TABLE "VisibilityRecoveryReview" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VisibilityRecoveryReview_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "VisibilityRecoveryReview_operationId_createdAt_idx" ON "VisibilityRecoveryReview"("operationId", "createdAt");
CREATE INDEX "VisibilityRecoveryReview_workspaceId_createdAt_idx" ON "VisibilityRecoveryReview"("workspaceId", "createdAt");
ALTER TABLE "VisibilityRecoveryReview" ADD CONSTRAINT "VisibilityRecoveryReview_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "VisibilityUsageOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VisibilityRecoveryReview" ADD CONSTRAINT "VisibilityRecoveryReview_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
