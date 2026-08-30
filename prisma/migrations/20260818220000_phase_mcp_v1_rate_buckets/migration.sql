-- Phase MCP V1 C: durable per-workspace MCP rate buckets

CREATE TABLE "McpRateBucket" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpRateBucket_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "McpRateBucket_workspaceId_action_windowStart_key" ON "McpRateBucket"("workspaceId", "action", "windowStart");
CREATE INDEX "McpRateBucket_workspaceId_action_idx" ON "McpRateBucket"("workspaceId", "action");

ALTER TABLE "McpRateBucket" ADD CONSTRAINT "McpRateBucket_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
