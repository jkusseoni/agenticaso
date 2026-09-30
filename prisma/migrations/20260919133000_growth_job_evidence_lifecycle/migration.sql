-- Growth Phase 3B: evidence survives job deletion; run-scoped IDs; job lease.

ALTER TABLE "GrowthJob" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

CREATE INDEX "GrowthJob_status_leaseExpiresAt_idx" ON "GrowthJob"("status", "leaseExpiresAt");

ALTER TABLE "GrowthEvidence" ADD COLUMN "runId" TEXT;

UPDATE "GrowthEvidence" SET "runId" = "jobId" WHERE "runId" IS NULL;

ALTER TABLE "GrowthEvidence" ALTER COLUMN "runId" SET NOT NULL;

ALTER TABLE "GrowthEvidence" DROP CONSTRAINT "GrowthEvidence_jobId_fkey";

ALTER TABLE "GrowthEvidence" ALTER COLUMN "jobId" DROP NOT NULL;

ALTER TABLE "GrowthEvidence" ADD CONSTRAINT "GrowthEvidence_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GrowthJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DROP INDEX "GrowthEvidence_jobId_packEvidenceId_key";

DROP INDEX "GrowthEvidence_prospectId_jobId_idx";

CREATE UNIQUE INDEX "GrowthEvidence_prospectId_runId_packEvidenceId_key" ON "GrowthEvidence"("prospectId", "runId", "packEvidenceId");

CREATE INDEX "GrowthEvidence_prospectId_runId_idx" ON "GrowthEvidence"("prospectId", "runId");

CREATE INDEX "GrowthEvidence_jobId_idx" ON "GrowthEvidence"("jobId");

DROP INDEX "GrowthQualification_jobId_idx";

CREATE UNIQUE INDEX "GrowthQualification_jobId_key" ON "GrowthQualification"("jobId");
