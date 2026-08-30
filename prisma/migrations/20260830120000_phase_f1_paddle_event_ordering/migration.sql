-- Phase F.1: durable Paddle webhook ordering (occurred_at)

ALTER TABLE "Subscription" ADD COLUMN "lastPaddleEventAt" TIMESTAMP(3);
