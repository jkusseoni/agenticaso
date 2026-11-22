-- CreateEnum
CREATE TYPE "LeadVerificationStatus" AS ENUM ('pending', 'processing', 'verified', 'failed', 'expired');

-- CreateTable
CREATE TABLE "ReportEmailLead" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "websiteUrl" TEXT NOT NULL,
    "verificationHash" TEXT NOT NULL,
    "status" "LeadVerificationStatus" NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "processingStartedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "reportSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportEmailLead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReportEmailLead_verificationHash_key" ON "ReportEmailLead"("verificationHash");

-- CreateIndex
CREATE INDEX "ReportEmailLead_email_createdAt_idx" ON "ReportEmailLead"("email", "createdAt");

-- CreateIndex
CREATE INDEX "ReportEmailLead_status_expiresAt_idx" ON "ReportEmailLead"("status", "expiresAt");
