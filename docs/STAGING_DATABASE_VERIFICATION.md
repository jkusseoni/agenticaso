# Agenticaso — staging database verification (read-only first)

This runbook is for the **Neon staging branch only**. Do not run commands against production, do not paste connection strings, and do not run `prisma migrate deploy`, `prisma migrate reset`, `prisma db push`, or raw migration SQL during this verification.

## 1. Identify environment without exposing secrets

Run in PowerShell from the local checkout containing the intended staging `.env`:

```powershell
Get-Location
git branch --show-current
git status --short
node -e "require('dotenv/config'); for (const key of ['DATABASE_URL','DIRECT_URL']) { const raw=process.env[key]; if (!raw) { console.log(key+': NOT SET'); continue; } try { const u=new URL(raw); console.log(key+': '+u.hostname+' / database='+u.pathname.slice(1)+' / pooled='+u.hostname.includes('-pooler')); } catch { console.log(key+': INVALID URL'); } }"
```

**Safety:** Hostnames and database names are environment identifiers; if sharing screenshots, redact them too. Never print full URLs, usernames, passwords, tokens, or environment files. Confirm in the Neon dashboard that both connections belong to the **staging branch**, not the production branch. Pooled and direct hostnames may differ.

## 2. Read migration state

After confirming staging, run:

```powershell
npx prisma migrate status
```

This is a read-only status check. Record the migration names and whether Prisma reports drift, unapplied migrations, or a failed migration. **Do not** immediately deploy or resolve migrations.

## 3. Read schema inventory

Use the Neon SQL editor for the staging branch only:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name;

SELECT migration_name, finished_at, rolled_back_at
FROM public._prisma_migrations
ORDER BY started_at;

SELECT
  to_regclass('public."UsageRequest"') AS legacy_usage_request,
  to_regclass('public."UsageReservation"') AS legacy_usage_reservation,
  to_regclass('public."VisibilityUsageOperation"') AS visibility_usage_operation,
  to_regclass('public."VisibilityRecoveryReview"') AS visibility_recovery_review,
  to_regclass('public."VisibilityRecoveryGrantAudit"') AS visibility_recovery_grant_audit;
```

Do not run `DROP TABLE`, `ALTER TABLE`, `DELETE`, `TRUNCATE`, or `UPDATE` in the staging or production database.

## 4. Acceptance gate

- Neon dashboard proves staging is separate from production.
- `DATABASE_URL` and `DIRECT_URL` resolve to the intended staging branch.
- Migration history is consistent with checked-in `prisma/migrations`.
- No unexplained legacy tables, missing required tables, or failed migrations.
- Any proposed schema changes have a reviewed migration plan and backup/rollback strategy.

**If any gate fails:** stop. Save redacted command output and investigate before changing schema. Passing CI against disposable PostgreSQL does not imply a safe migration path for an existing Neon database.
