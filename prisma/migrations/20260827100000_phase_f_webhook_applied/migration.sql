-- Phase F P0: webhook events are idempotent only after successful apply

ALTER TABLE "BillingWebhookEvent" ADD COLUMN "applied" BOOLEAN NOT NULL DEFAULT true;
