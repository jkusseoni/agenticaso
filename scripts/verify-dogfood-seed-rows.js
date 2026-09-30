import { PrismaClient } from "@prisma/client";
import { CARTRENEW_DOGFOOD_CAMPAIGN } from "../lib/growth/dogfood.js";
import { SYNTHETIC_DOGFOOD_CLERK_USER_ID, assertStagingTarget, loadDogfoodEnv } from "../lib/growth/dogfood-env.js";

const loaded = loadDogfoodEnv();
const identity = assertStagingTarget(loaded);
if (!identity.ok) {
  console.log(JSON.stringify(identity, null, 2));
  process.exit(2);
}
const workspaceId = loaded.GROWTH_DOGFOOD_WORKSPACE_ID;
const prisma = new PrismaClient({ datasources: { db: { url: loaded.GROWTH_DOGFOOD_DATABASE_URL } } });
try {
  const campaigns = await prisma.growthCampaign.findMany({
    where: { workspaceId, name: CARTRENEW_DOGFOOD_CAMPAIGN.name },
  });
  const campaignIds = campaigns.map((c) => c.id);
  const prospects = campaignIds.length
    ? await prisma.growthProspect.findMany({
        where: { campaignId: { in: campaignIds } },
        orderBy: { canonicalDomain: "asc" },
      })
    : [];
  const jobs = campaignIds.length
    ? await prisma.growthJob.findMany({
        where: { campaignId: { in: campaignIds } },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const evidence = await prisma.growthEvidence.count();
  const qualifications = await prisma.growthQualification.count();
  const critic = await prisma.growthCriticReview.count();
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { clerkUserId: true },
  });

  console.log(
    JSON.stringify(
      {
        host: identity.staging.redactedHost,
        database: identity.staging.database,
        workspaceSynthetic: workspace?.clerkUserId === SYNTHETIC_DOGFOOD_CLERK_USER_ID,
        campaignCount: campaigns.length,
        campaigns: campaigns.map((c) => ({
          id: c.id,
          status: c.status,
          productName: c.productName,
          productUrl: c.productUrl,
          targetPlatform: c.targetPlatform,
          goal: c.goal,
          desiredSignals: c.desiredSignals,
        })),
        prospectCount: prospects.length,
        uniqueDomains: [...new Set(prospects.map((p) => p.canonicalDomain))],
        prospects: prospects.map((p) => ({
          id: p.id,
          canonicalDomain: p.canonicalDomain,
          originalUrl: p.originalUrl,
          normalizedUrl: p.normalizedUrl,
          lifecycleState: p.lifecycleState,
          platformStatus: p.platformStatus,
          latestQualificationDecision: p.latestQualificationDecision,
          latestReviewState: p.latestReviewState,
        })),
        jobCount: jobs.length,
        pendingResearchJobs: jobs.filter((j) => j.type === "research" && j.status === "pending").length,
        jobs: jobs.map((j) => ({
          id: j.id,
          prospectId: j.prospectId,
          type: j.type,
          status: j.status,
        })),
        evidence,
        qualifications,
        critic,
      },
      null,
      2
    )
  );
} finally {
  await prisma.$disconnect();
}
