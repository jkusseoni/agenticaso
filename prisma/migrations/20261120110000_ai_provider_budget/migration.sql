-- Estimated application-side AI spend ceilings.
-- These rows do not limit the provider account and are not billing usage.

CREATE TABLE "AiProviderSpendDay" (
    "day" TEXT NOT NULL,
    "spentCalls" INTEGER NOT NULL DEFAULT 0,
    "spentCents" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiProviderSpendDay_pkey" PRIMARY KEY ("day"),
    CONSTRAINT "AiProviderSpendDay_amount_check" CHECK ("spentCalls" >= 0 AND "spentCents" >= 0)
);

CREATE TABLE "AiProviderScanBudget" (
    "id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "spentCalls" INTEGER NOT NULL DEFAULT 0,
    "spentCents" INTEGER NOT NULL DEFAULT 0,
    "maxCalls" INTEGER NOT NULL,
    "maxCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiProviderScanBudget_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiProviderScanBudget_amount_check" CHECK (
        "spentCalls" >= 0 AND "spentCents" >= 0 AND
        "maxCalls" >= 0 AND "maxCents" >= 0 AND
        "spentCalls" <= "maxCalls" AND "spentCents" <= "maxCents"
    )
);

CREATE INDEX "AiProviderScanBudget_day_idx" ON "AiProviderScanBudget"("day");
