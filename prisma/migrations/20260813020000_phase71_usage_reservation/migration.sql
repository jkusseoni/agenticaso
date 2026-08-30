-- Phase 7.1: usage reservation for concurrent-safe AI test allowance
ALTER TABLE "UsagePeriod" ADD COLUMN IF NOT EXISTS "aiTestsReserved" INTEGER NOT NULL DEFAULT 0;
