# Agenticaso staging environment discovery and isolation

**Status: UNVERIFIED / HOLD — 2026-10-26.** GitHub repository inspection alone cannot establish whether Vercel Preview/Staging or a separate Neon branch exists. Do not migrate or deploy until independently verified.

## Repository observations

- The feature branch contains one workflow: `.github/workflows/billing-visibility-safety.yml`. It runs disposable PostgreSQL 16 for CI; that service is **not** a persistent staging database.
- No root `vercel.json` or staging-specific deployment workflow was found on the inspected branch.
- `.env.example` documents pooled `DATABASE_URL` and direct `DIRECT_URL` for Neon; placeholders do not establish real environment configuration.
- The Prisma datasource uses `DATABASE_URL` for runtime and `DIRECT_URL` for migrations.
- No Vercel or Neon account settings, environment secrets, branch databases, or deployment logs were accessed by this review.

## Safe discovery procedure (no credentials in chat)

1. In Vercel, inspect the Agenticaso project: **Settings → Environments** and **Deployments**. Note whether a dedicated staging environment exists, which Git branch it tracks, and whether it is isolated from Production. Preview deployments alone do not prove database isolation.
2. In Vercel, inspect **Settings → Environment Variables**. Verify the **scope**, not the values, of `DATABASE_URL`, `DIRECT_URL`, Clerk keys, Paddle keys, and webhook/cron secrets for Production versus Preview/Staging. Do not copy or share secret values.
3. In Neon, inspect the project **Branches** and database roles. Verify that staging uses a separate database branch or isolated database and that its connection endpoints are distinct from production. Never paste connection strings.
4. Confirm staging has test-mode payment settings, non-production Clerk configuration or appropriately isolated users, disabled outbound customer messaging, and isolated scheduled jobs/webhooks.
5. Record only redacted evidence: environment name, branch name, whether database host/branch differs (yes/no), billing mode (sandbox/live), and reviewer/date.

## Decision gate

- **If staging is absent:** provision a separate Neon branch/database and Vercel staging/preview environment using separate credentials, sandbox billing, and disabled side effects; verify isolation before any migration.
- **If staging exists:** verify role permissions and database isolation, then rehearse migrations and backup/restore in a disposable clone.
- **If unknown:** keep PR draft, do not run production migrations, and ask the project owner for non-secret dashboard confirmation.

**No production change is authorized by this document.**
