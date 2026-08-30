-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "QuestionCategory" AS ENUM ('discovery', 'comparison', 'problem', 'alternative', 'purchase', 'category');

-- CreateEnum
CREATE TYPE "AuditStatus" AS ENUM ('pending', 'running', 'completed', 'failed');

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "clerkUserId" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Website" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "brandName" TEXT,
    "category" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Website_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerQuestion" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "category" "QuestionCategory" NOT NULL DEFAULT 'category',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuyerQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Audit" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "status" "AuditStatus" NOT NULL DEFAULT 'pending',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "mentionShare" DOUBLE PRECISION,
    "recommendationShare" DOUBLE PRECISION,
    "top3Share" DOUBLE PRECISION,
    "providerMetrics" JSONB,
    "foundScore" DOUBLE PRECISION,
    "foundStatus" TEXT,
    "understoodScore" DOUBLE PRECISION,
    "understoodStatus" TEXT,
    "recommendedScore" DOUBLE PRECISION,
    "recommendedStatus" TEXT,
    "boughtScore" DOUBLE PRECISION,
    "boughtStatus" TEXT,
    "overallScore" DOUBLE PRECISION,
    "overallStatus" TEXT,
    "intelligenceSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditQuestion" (
    "auditId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AuditQuestion_pkey" PRIMARY KEY ("auditId","questionId")
);

-- CreateTable
CREATE TABLE "AiTest" (
    "id" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "questionId" TEXT,
    "answer" TEXT,
    "storeAnswer" BOOLEAN NOT NULL DEFAULT true,
    "brandMentioned" BOOLEAN NOT NULL DEFAULT false,
    "recommended" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER,
    "competitors" JSONB,
    "citations" JSONB,
    "confidence" DOUBLE PRECISION,
    "latencyMs" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitorSnapshot" (
    "id" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mentions" INTEGER NOT NULL DEFAULT 0,
    "recommendations" INTEGER NOT NULL DEFAULT 0,
    "top3" INTEGER NOT NULL DEFAULT 0,
    "averagePosition" DOUBLE PRECISION,
    "mentionShare" DOUBLE PRECISION,
    "recommendationShare" DOUBLE PRECISION,
    "top3Share" DOUBLE PRECISION,

    CONSTRAINT "CompetitorSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerceptionSnapshot" (
    "id" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "brandThemes" JSONB NOT NULL,
    "aiThemes" JSONB NOT NULL,
    "missingThemes" JSONB NOT NULL,
    "unexpectedThemes" JSONB NOT NULL,
    "method" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerceptionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_clerkUserId_key" ON "Workspace"("clerkUserId");

-- CreateIndex
CREATE INDEX "Workspace_clerkUserId_idx" ON "Workspace"("clerkUserId");

-- CreateIndex
CREATE INDEX "Website_workspaceId_idx" ON "Website"("workspaceId");

-- CreateIndex
CREATE INDEX "Website_domain_idx" ON "Website"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "Website_workspaceId_domain_key" ON "Website"("workspaceId", "domain");

-- CreateIndex
CREATE INDEX "BuyerQuestion_websiteId_active_idx" ON "BuyerQuestion"("websiteId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "BuyerQuestion_websiteId_question_key" ON "BuyerQuestion"("websiteId", "question");

-- CreateIndex
CREATE INDEX "Audit_websiteId_status_completedAt_idx" ON "Audit"("websiteId", "status", "completedAt");

-- CreateIndex
CREATE INDEX "Audit_websiteId_completedAt_idx" ON "Audit"("websiteId", "completedAt");

-- CreateIndex
CREATE INDEX "AuditQuestion_questionId_idx" ON "AuditQuestion"("questionId");

-- CreateIndex
CREATE INDEX "AiTest_auditId_provider_idx" ON "AiTest"("auditId", "provider");

-- CreateIndex
CREATE INDEX "AiTest_auditId_questionId_idx" ON "AiTest"("auditId", "questionId");

-- CreateIndex
CREATE INDEX "CompetitorSnapshot_auditId_idx" ON "CompetitorSnapshot"("auditId");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitorSnapshot_auditId_name_key" ON "CompetitorSnapshot"("auditId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PerceptionSnapshot_auditId_key" ON "PerceptionSnapshot"("auditId");

-- AddForeignKey
ALTER TABLE "Website" ADD CONSTRAINT "Website_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerQuestion" ADD CONSTRAINT "BuyerQuestion_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Audit" ADD CONSTRAINT "Audit_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditQuestion" ADD CONSTRAINT "AuditQuestion_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "Audit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditQuestion" ADD CONSTRAINT "AuditQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "BuyerQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTest" ADD CONSTRAINT "AiTest_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "Audit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorSnapshot" ADD CONSTRAINT "CompetitorSnapshot_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "Audit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerceptionSnapshot" ADD CONSTRAINT "PerceptionSnapshot_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "Audit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
