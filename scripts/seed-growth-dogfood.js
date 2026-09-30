/**
 * CartRenew dogfood seed. Dry-run unless GROWTH_DOGFOOD_CONFIRM=YES
 * and the database is classified local or staging/non-production.
 *
 * Required env:
 *   GROWTH_DOGFOOD_WORKSPACE_ID
 * Optional:
 *   GROWTH_DOGFOOD_URLS          comma/space-separated, max 3
 *   GROWTH_DOGFOOD_CONFIRM=YES   required for writes
 *   GROWTH_DOGFOOD_ENV           local | staging | production
 *   DATABASE_URL / DIRECT_URL
 *
 * Usage:
 *   node scripts/seed-growth-dogfood.js
 *   node scripts/seed-growth-dogfood.js --url https://a.example --url https://b.example
 */
import { PrismaClient } from "@prisma/client";
import {
  CARTRENEW_DOGFOOD_CAMPAIGN,
  classifyDatabaseUrl,
  isDogfoodConfirm,
  loadDogfoodDatabaseUrl,
  parseDogfoodUrls,
  planDogfoodSeed,
  redactId,
  writesAllowed,
} from "../lib/growth/dogfood.js";
import { SYNTHETIC_DOGFOOD_CLERK_USER_ID, assertStagingTarget, loadDogfoodEnv } from "../lib/growth/dogfood-env.js";

function argvUrls(argv) {
  const out = [];
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--url" && argv[i + 1]) {
      out.push(argv[++i]);
    }
  }
  return out;
}

function loadDatabaseUrl() {
  return loadDogfoodDatabaseUrl(process.env);
}

async function main() {
  const dogfoodEnv = loadDogfoodEnv();
  const dbUrl = dogfoodEnv.GROWTH_DOGFOOD_DATABASE_URL || loadDatabaseUrl();
  const classified = classifyDatabaseUrl(dbUrl, {
    ...process.env,
    GROWTH_DOGFOOD_ENV: dogfoodEnv.GROWTH_DOGFOOD_ENV || process.env.GROWTH_DOGFOOD_ENV,
  });
  const workspaceId = String(dogfoodEnv.GROWTH_DOGFOOD_WORKSPACE_ID || process.env.GROWTH_DOGFOOD_WORKSPACE_ID || "").trim();
  const fromArgv = argvUrls(process.argv);
  const fromEnv = parseDogfoodUrls(process.env.GROWTH_DOGFOOD_URLS || dogfoodEnv.GROWTH_DOGFOOD_URLS || "");
  if (!fromEnv.ok) {
    console.error(JSON.stringify({ ok: false, error: fromEnv.error }, null, 2));
    process.exit(1);
  }
  const urls = fromArgv.length ? fromArgv : fromEnv.urls;
  if (urls.length > 3) {
    console.error(JSON.stringify({ ok: false, error: "at_most_three_urls" }, null, 2));
    process.exit(1);
  }

  const plan = planDogfoodSeed({ workspaceId, urls, existing: {} });
  const confirm = isDogfoodConfirm({
    ...process.env,
    GROWTH_DOGFOOD_CONFIRM: dogfoodEnv.GROWTH_DOGFOOD_CONFIRM || process.env.GROWTH_DOGFOOD_CONFIRM,
  });
  const identity = assertStagingTarget(dogfoodEnv);
  const writeGate = writesAllowed(classified.classification, {
    ...process.env,
    GROWTH_DOGFOOD_CONFIRM: dogfoodEnv.GROWTH_DOGFOOD_CONFIRM || process.env.GROWTH_DOGFOOD_CONFIRM,
  });
  const collisionBlocked = !identity.ok && identity.token === "STAGING_DATABASE_COLLISION";
  const productionProtected = classified.classification === "production" || collisionBlocked;

  const report = {
    dryRun: !writeGate.ok,
    confirm,
    database: {
      classification: classified.classification,
      host: classified.host,
      database: classified.database,
      reason: classified.reason || classified.error,
    },
    workspaceId: workspaceId ? redactId(workspaceId) : null,
    campaignProfile: {
      name: CARTRENEW_DOGFOOD_CAMPAIGN.name,
      productName: CARTRENEW_DOGFOOD_CAMPAIGN.productName,
      productUrl: CARTRENEW_DOGFOOD_CAMPAIGN.productUrl,
      targetPlatform: CARTRENEW_DOGFOOD_CAMPAIGN.targetPlatform,
      goal: CARTRENEW_DOGFOOD_CAMPAIGN.goal,
      desiredSignals: CARTRENEW_DOGFOOD_CAMPAIGN.desiredSignals,
    },
    urls: plan.ok
      ? plan.prospects.map((p) => ({
          originalUrl: p.identity.originalUrl,
          normalizedUrl: p.identity.normalizedUrl,
          canonicalDomain: p.identity.canonicalDomain,
        }))
      : [],
    wouldCreate: plan.ok ? plan.wouldCreate : { campaigns: 0, prospects: 0, researchJobs: 0 },
    writeBlockedReason: collisionBlocked
      ? identity.token
      : !identity.ok
        ? identity.error || identity.token
        : writeGate.ok
          ? null
          : writeGate.reason,
    notes: [
      "No public Growth API. Seed is manual and idempotent.",
      "Worker remains disabled until GROWTH_AGENT_ENABLED=true and workspace allowlist is set.",
      "Do not add Vercel cron for this dogfood.",
    ],
  };

  if (!plan.ok && workspaceId) {
    report.planError = plan.error;
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  if (!workspaceId) {
    report.planError = "missing_GROWTH_DOGFOOD_WORKSPACE_ID";
    report.dryRun = true;
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  if (productionProtected || !identity.ok || !writeGate.ok) {
    report.dryRun = true;
    if (productionProtected) report.writeBlockedReason = collisionBlocked ? identity.token : "PRODUCTION_DB_APPROVAL_REQUIRED";
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (!urls.length) {
    report.planError = "no_prospect_urls";
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  try {
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!workspace) {
      report.planError = "workspace_not_found";
      console.log(JSON.stringify({ ...report, dryRun: true }, null, 2));
      process.exit(1);
    }
    if (workspace.clerkUserId !== SYNTHETIC_DOGFOOD_CLERK_USER_ID) {
      report.planError = "workspace_not_synthetic_dogfood";
      console.log(JSON.stringify({ ...report, dryRun: true }, null, 2));
      process.exit(1);
    }
    const existingCampaign = await prisma.growthCampaign.findFirst({
      where: { workspaceId, name: CARTRENEW_DOGFOOD_CAMPAIGN.name },
    });
    const existingProspects = existingCampaign
      ? await prisma.growthProspect.findMany({ where: { campaignId: existingCampaign.id } })
      : [];
    const researchJobs = [];
    for (const p of existingProspects) {
      const job = await prisma.growthJob.findFirst({
        where: { prospectId: p.id, type: "research" },
      });
      if (job) researchJobs.push({ canonicalDomain: p.canonicalDomain, jobId: job.id });
    }
    const livePlan = planDogfoodSeed({
      workspaceId,
      urls,
      existing: {
        campaignId: existingCampaign?.id || null,
        prospects: existingProspects,
        researchJobs,
      },
    });
    report.wouldCreate = livePlan.wouldCreate;
    report.existingCampaignId = existingCampaign ? redactId(existingCampaign.id) : null;

    const campaign =
      existingCampaign ||
      (await prisma.growthCampaign.create({
        data: livePlan.campaignData,
      }));

    const created = { campaigns: existingCampaign ? 0 : 1, prospects: 0, researchJobs: 0 };
    for (const item of livePlan.prospects) {
      let prospect = existingProspects.find((p) => p.canonicalDomain === item.identity.canonicalDomain);
      if (!prospect) {
        prospect = await prisma.growthProspect.create({
          data: {
            campaignId: campaign.id,
            originalUrl: item.identity.originalUrl,
            normalizedUrl: item.identity.normalizedUrl,
            canonicalDomain: item.identity.canonicalDomain,
            lifecycleState: "research_pending",
          },
        });
        created.prospects += 1;
      } else if (prospect.lifecycleState === "candidate") {
        await prisma.growthProspect.update({
          where: { id: prospect.id },
          data: { lifecycleState: "research_pending" },
        });
      }
      const job = await prisma.growthJob.findFirst({
        where: { prospectId: prospect.id, type: "research" },
      });
      if (!job) {
        await prisma.growthJob.create({
          data: {
            campaignId: campaign.id,
            prospectId: prospect.id,
            type: "research",
            status: "pending",
            availableAt: new Date(),
          },
        });
        created.researchJobs += 1;
      }
    }
    report.dryRun = false;
    report.created = created;
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(String(err?.message || err).slice(0, 300));
  process.exit(1);
});
