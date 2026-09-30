-- First-paid conversion metadata. Write-once. Does not grant entitlement.

ALTER TABLE "Subscription" ADD COLUMN "firstPaidAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "firstPaidTransactionId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "firstPaidAmount" INTEGER;
ALTER TABLE "Subscription" ADD COLUMN "firstPaidCurrency" TEXT;

CREATE UNIQUE INDEX "Subscription_firstPaidTransactionId_key" ON "Subscription"("firstPaidTransactionId");

-- Historical Paddle subscribers already converted. Do not invent transaction id, amount, or currency.
UPDATE "Subscription"
SET "firstPaidAt" = "createdAt"
WHERE "provider" = 'paddle'
  AND "providerSubscriptionId" IS NOT NULL
  AND "firstPaidAt" IS NULL;
