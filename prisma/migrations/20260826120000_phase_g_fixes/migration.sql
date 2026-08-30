-- Phase G: persisted AI Action Engine fixes

CREATE TABLE "Fix" (
    "id" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "codeSnippet" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'json',
    "isApplied" BOOLEAN NOT NULL DEFAULT false,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Fix_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Fix_auditId_category_key" ON "Fix"("auditId", "category");
CREATE INDEX "Fix_auditId_idx" ON "Fix"("auditId");
CREATE INDEX "Fix_workspaceId_idx" ON "Fix"("workspaceId");

ALTER TABLE "Fix" ADD CONSTRAINT "Fix_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "Audit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
