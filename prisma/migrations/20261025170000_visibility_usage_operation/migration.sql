-- Schema-only preparation for durable Visibility settlement.
-- No backfill: existing aggregate UsagePeriod counters remain untouched.
-- Runtime code must not use this table until transactional settlement is implemented.

CREATE TABLE "VisibilityUsageOperation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "usagePeriodId" TEXT NOT NULL,
    "reservedAiTests" INTEGER NOT NULL,
    "actualAiTests" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VisibilityUsageOperation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "VisibilityUsageOperation_status_check" CHECK ("status" IN ('reserved', 'committed', 'released')),
    CONSTRAINT "VisibilityUsageOperation_amount_check" CHECK (
        "reservedAiTests" >= 0 AND
        ("actualAiTests" IS NULL OR ("actualAiTests" >= 0 AND "actualAiTests" <= "reservedAiTests"))
    )
);

CREATE INDEX "VisibilityUsageOperation_workspaceId_createdAt_idx"
    ON "VisibilityUsageOperation"("workspaceId", "createdAt");
CREATE INDEX "VisibilityUsageOperation_usagePeriodId_status_idx"
    ON "VisibilityUsageOperation"("usagePeriodId", "status");

ALTER TABLE "VisibilityUsageOperation"
    ADD CONSTRAINT "VisibilityUsageOperation_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VisibilityUsageOperation"
    ADD CONSTRAINT "VisibilityUsageOperation_usagePeriodId_fkey"
    FOREIGN KEY ("usagePeriodId") REFERENCES "UsagePeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
