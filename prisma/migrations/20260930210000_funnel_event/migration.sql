-- Growth funnel Phase 1A. Event name, optional session, optional workspace. No PII or payment fields.

CREATE TABLE "FunnelEvent" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "sessionId" TEXT,
    "workspaceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FunnelEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FunnelEvent_event_createdAt_idx" ON "FunnelEvent"("event", "createdAt");
CREATE INDEX "FunnelEvent_workspaceId_event_idx" ON "FunnelEvent"("workspaceId", "event");

ALTER TABLE "FunnelEvent" ADD CONSTRAINT "FunnelEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
