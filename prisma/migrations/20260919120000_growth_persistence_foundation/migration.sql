-- Growth Phase 3A: persistence foundation (campaigns, prospects, evidence, qualifications, jobs)
-- Additive only. Does not alter Website, Audit, billing, or MCP tables.

CREATE TYPE "GrowthCampaignStatus" AS ENUM ('draft', 'active', 'paused', 'completed', 'archived');
CREATE TYPE "GrowthProspectLifecycle" AS ENUM ('candidate', 'research_pending', 'researching', 'researched', 'qualification_pending', 'qualifying', 'qualified', 'needs_review', 'rejected', 'failed');
CREATE TYPE "GrowthQualificationDecision" AS ENUM ('strong_fit', 'possible_fit', 'weak_fit', 'not_fit', 'insufficient_evidence');
CREATE TYPE "GrowthReviewState" AS ENUM ('accepted', 'needs_review', 'rejected');
CREATE TYPE "GrowthJobType" AS ENUM ('research', 'qualify', 'critic');
CREATE TYPE "GrowthJobStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'cancelled');
CREATE TYPE "GrowthReasonType" AS ENUM ('observation', 'inference');
CREATE TYPE "GrowthProducedBy" AS ENUM ('llm', 'deterministic');

CREATE TABLE "GrowthCampaign" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "GrowthCampaignStatus" NOT NULL DEFAULT 'draft',
    "productName" TEXT NOT NULL,
    "productUrl" TEXT NOT NULL,
    "productDescription" VARCHAR(500) NOT NULL,
    "goal" TEXT NOT NULL,
    "targetPlatform" TEXT NOT NULL,
    "desiredSignals" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GrowthCampaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GrowthProspect" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "originalUrl" TEXT NOT NULL,
    "normalizedUrl" TEXT NOT NULL,
    "canonicalDomain" TEXT NOT NULL,
    "platformStatus" TEXT,
    "lifecycleState" "GrowthProspectLifecycle" NOT NULL DEFAULT 'candidate',
    "latestQualificationDecision" "GrowthQualificationDecision",
    "latestReviewState" "GrowthReviewState",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GrowthProspect_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GrowthJob" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "prospectId" TEXT,
    "type" "GrowthJobType" NOT NULL,
    "status" "GrowthJobStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "lastErrorCode" VARCHAR(80),
    "lastErrorMessage" VARCHAR(300),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GrowthJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GrowthEvidence" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "packEvidenceId" TEXT NOT NULL,
    "claim" VARCHAR(280) NOT NULL,
    "sourceUrl" TEXT,
    "sourceType" TEXT,
    "observedData" VARCHAR(280),
    "confidence" DOUBLE PRECISION,
    "verificationStatus" TEXT,
    "extractor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrowthEvidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GrowthQualification" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "jobId" TEXT,
    "decision" "GrowthQualificationDecision" NOT NULL,
    "summary" VARCHAR(600) NOT NULL,
    "producedBy" "GrowthProducedBy" NOT NULL DEFAULT 'llm',
    "shortCircuited" BOOLEAN NOT NULL DEFAULT false,
    "structuralOk" BOOLEAN NOT NULL DEFAULT true,
    "reasonerModel" TEXT,
    "reasonerProvider" TEXT,
    "uncertainties" JSONB NOT NULL,
    "evidencePackVersion" INTEGER NOT NULL DEFAULT 1,
    "qualificationContractVersion" INTEGER NOT NULL DEFAULT 1,
    "reasonerPromptVersion" INTEGER NOT NULL DEFAULT 1,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "reasonerCallCount" INTEGER,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "totalTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrowthQualification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GrowthQualificationReason" (
    "id" TEXT NOT NULL,
    "qualificationId" TEXT NOT NULL,
    "type" "GrowthReasonType" NOT NULL,
    "statement" VARCHAR(400) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "GrowthQualificationReason_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GrowthQualificationReasonEvidence" (
    "reasonId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,

    CONSTRAINT "GrowthQualificationReasonEvidence_pkey" PRIMARY KEY ("reasonId","evidenceId")
);

CREATE TABLE "GrowthCriticReview" (
    "id" TEXT NOT NULL,
    "qualificationId" TEXT NOT NULL,
    "policyVerdict" TEXT,
    "llmVerdict" TEXT,
    "finalVerdict" TEXT NOT NULL,
    "reviewState" "GrowthReviewState" NOT NULL,
    "criticModel" TEXT,
    "criticProvider" TEXT,
    "items" JSONB,
    "criticPromptVersion" INTEGER NOT NULL DEFAULT 1,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "totalTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrowthCriticReview_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GrowthCampaign_workspaceId_status_idx" ON "GrowthCampaign"("workspaceId", "status");

CREATE UNIQUE INDEX "GrowthProspect_campaignId_canonicalDomain_key" ON "GrowthProspect"("campaignId", "canonicalDomain");
CREATE INDEX "GrowthProspect_campaignId_lifecycleState_idx" ON "GrowthProspect"("campaignId", "lifecycleState");
CREATE INDEX "GrowthProspect_canonicalDomain_idx" ON "GrowthProspect"("canonicalDomain");

CREATE INDEX "GrowthJob_status_availableAt_idx" ON "GrowthJob"("status", "availableAt");
CREATE INDEX "GrowthJob_campaignId_prospectId_idx" ON "GrowthJob"("campaignId", "prospectId");
CREATE INDEX "GrowthJob_prospectId_type_status_idx" ON "GrowthJob"("prospectId", "type", "status");

CREATE UNIQUE INDEX "GrowthEvidence_jobId_packEvidenceId_key" ON "GrowthEvidence"("jobId", "packEvidenceId");
CREATE INDEX "GrowthEvidence_prospectId_jobId_idx" ON "GrowthEvidence"("prospectId", "jobId");

CREATE INDEX "GrowthQualification_prospectId_createdAt_idx" ON "GrowthQualification"("prospectId", "createdAt");
CREATE INDEX "GrowthQualification_jobId_idx" ON "GrowthQualification"("jobId");

CREATE INDEX "GrowthQualificationReason_qualificationId_sortOrder_idx" ON "GrowthQualificationReason"("qualificationId", "sortOrder");

CREATE INDEX "GrowthQualificationReasonEvidence_evidenceId_idx" ON "GrowthQualificationReasonEvidence"("evidenceId");

CREATE UNIQUE INDEX "GrowthCriticReview_qualificationId_key" ON "GrowthCriticReview"("qualificationId");

ALTER TABLE "GrowthCampaign" ADD CONSTRAINT "GrowthCampaign_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GrowthProspect" ADD CONSTRAINT "GrowthProspect_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "GrowthCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GrowthJob" ADD CONSTRAINT "GrowthJob_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "GrowthCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GrowthJob" ADD CONSTRAINT "GrowthJob_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "GrowthProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GrowthEvidence" ADD CONSTRAINT "GrowthEvidence_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "GrowthProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GrowthEvidence" ADD CONSTRAINT "GrowthEvidence_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GrowthJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GrowthQualification" ADD CONSTRAINT "GrowthQualification_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "GrowthProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GrowthQualification" ADD CONSTRAINT "GrowthQualification_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GrowthJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GrowthQualificationReason" ADD CONSTRAINT "GrowthQualificationReason_qualificationId_fkey" FOREIGN KEY ("qualificationId") REFERENCES "GrowthQualification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GrowthQualificationReasonEvidence" ADD CONSTRAINT "GrowthQualificationReasonEvidence_reasonId_fkey" FOREIGN KEY ("reasonId") REFERENCES "GrowthQualificationReason"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GrowthQualificationReasonEvidence" ADD CONSTRAINT "GrowthQualificationReasonEvidence_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "GrowthEvidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GrowthCriticReview" ADD CONSTRAINT "GrowthCriticReview_qualificationId_fkey" FOREIGN KEY ("qualificationId") REFERENCES "GrowthQualification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
