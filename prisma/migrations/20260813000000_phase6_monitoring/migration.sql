-- Phase 6: Continuous AI visibility monitoring

CREATE TYPE "MonitoringFrequency" AS ENUM ('weekly', 'monthly');

CREATE TABLE "Monitoring" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "frequency" "MonitoringFrequency" NOT NULL DEFAULT 'weekly',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastScheduleKey" TEXT,
    "lastStatus" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Monitoring_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "auditId" TEXT,
    "monitoringId" TEXT,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "data" JSONB,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Monitoring_websiteId_key" ON "Monitoring"("websiteId");
CREATE INDEX "Monitoring_active_nextRunAt_idx" ON "Monitoring"("active", "nextRunAt");
CREATE INDEX "Monitoring_websiteId_idx" ON "Monitoring"("websiteId");

CREATE INDEX "Alert_websiteId_createdAt_idx" ON "Alert"("websiteId", "createdAt");
CREATE INDEX "Alert_websiteId_read_idx" ON "Alert"("websiteId", "read");
CREATE INDEX "Alert_monitoringId_idx" ON "Alert"("monitoringId");

ALTER TABLE "Monitoring" ADD CONSTRAINT "Monitoring_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "Audit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_monitoringId_fkey" FOREIGN KEY ("monitoringId") REFERENCES "Monitoring"("id") ON DELETE SET NULL ON UPDATE CASCADE;
