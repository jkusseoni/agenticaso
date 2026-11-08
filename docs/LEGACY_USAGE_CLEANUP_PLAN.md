# Legacy usage schema drift — review-only cleanup plan (2026-11-08)

**Status: BLOCKED — no cleanup approved or executed.** Scope is **Neon project `agenticaso-test`, branch `agenticaso-migration-test`, database `neondb` only**. Do not run this against `agenticaso-preview`, `production`, or the separate `agenticaso` project. Confirm Neon project, branch, database, and endpoint in the dashboard immediately before every query. Never publish connection strings.

## Evidence collected

- Current integration branch has 17 tracked Prisma migration files. The migration-test `_prisma_migrations` ledger lists the same 17 names, each with `finished_at` set and `rolled_back_at` null. This establishes **name/status agreement**, not checksum agreement or full schema equality.
- `prisma migrate status` reported up to date, while an independent schema comparison returned exit code 2 and identified legacy `UsageRequest` and `UsageReservation` tables, associated `UsageRequestStatus` and `UsageReservationStatus` enums, and five foreign keys.
- On migration-test/neondb, both legacy tables had zero rows at the time checked. This is a **point-in-time** observation.
- Five foreign keys were identified on the two legacy tables; no inbound foreign keys from other tables were reported. No views or triggers were found in the earlier targeted checks.
- Case-insensitive Git grep across tracked `prisma/migrations` found no reference to either legacy table or any `DROP TABLE` / `DROP TYPE` statement. The new `VisibilityUsageOperation` table is created in `20261025170000_visibility_usage_operation`; its migration explicitly says it is schema-only and not yet wired to runtime.
- Tracked source grep (excluding migrations) found legacy table names only in `docs/STAGING_DATABASE_VERIFICATION.md`. This does not rule out dynamically generated SQL, external jobs, or untracked code.

**Unresolved:** exact origin of legacy objects, dependency graph including stored routines/policies, historical use by deployed services, migration checksums, recovery point, and repeatable before/after diff. No conclusion that dropping is safe is warranted.

## Phase A — read-only preflight

1. In Neon, verify the project, branch, DB and endpoint. Capture timestamp and branch ID (no credentials). Confirm **branch-specific** backup/restore point and restore procedure, with an isolated restore test where feasible.
2. Check the deployed Preview and any scheduled/worker consumers for legacy SQL, including older deployments and scripts. Do not assume the integration branch search covers deployed code.
3. Run these **read-only** queries in migration-test/neondb, retain redacted outputs:

```sql
-- Legacy object presence and row counts; stop if either table is missing unexpectedly.
SELECT to_regclass('public."UsageRequest"') AS request_table,
       to_regclass('public."UsageReservation"') AS reservation_table;

SELECT (SELECT count(*) FROM public."UsageRequest") AS request_rows,
       (SELECT count(*) FROM public."UsageReservation") AS reservation_rows;

-- Catalog dependencies including objects beyond ordinary foreign keys.
SELECT d.classid::regclass::text AS dependent_catalog,
       d.objid, d.objsubid, d.refclassid::regclass::text AS referenced_catalog,
       d.refobjid, d.deptype
FROM pg_depend d
WHERE d.refobjid IN (
  'public."UsageRequest"'::regclass::oid,
  'public."UsageReservation"'::regclass::oid
)
ORDER BY 1, 2, 3;

-- SQL routines mentioning the legacy names (text matching is not exhaustive).
SELECT n.nspname AS schema_name, p.proname AS routine_name
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema')
  AND (pg_get_functiondef(p.oid) ILIKE '%UsageRequest%'
       OR pg_get_functiondef(p.oid) ILIKE '%UsageReservation%');

-- Migration checksum inventory; compare with source checksums offline.
SELECT migration_name, checksum, finished_at, rolled_back_at
FROM public."_prisma_migrations" ORDER BY migration_name;
```

4. Review row-level security policies, publications, external integrations, enum usages, and catalog dependency results; do not infer absence of dependencies solely from empty rows.
5. Produce and save the exact read-only Prisma drift SQL against the intended migration-test branch, and review the complete output. Exit code 2 denotes differences, not permission to apply them.

## Phase B — proposed change (NOT implemented)

- If preflight passes, prepare a **new forward-only Prisma migration** on a separate review branch. Never edit an already-applied migration, and never run `migrate reset` or `db push` on shared databases.
- Review precise dependency ordering and removal of the two legacy tables and two enum types. Use fully qualified names, avoid `CASCADE`, and include guardrails that fail if tables have data or unexpected dependent objects. Do not add destructive SQL until separately reviewed and authorized.
- First apply only to an isolated disposable clone of migration-test with a verified restore point. Confirm schema parity, application test suite, and migration history. A successful test on an empty DB is insufficient.
- Review explicit rollback as **restore from verified backup/branch**, not automatic reversal of destructive DDL. Document any downtime and impact.

## Acceptance criteria / release gate

- [ ] Branch and DB identity verified immediately before execution.
- [ ] Backup/restore point created and restoration tested.
- [ ] Legacy row counts reconfirmed; unexpected data blocks cleanup.
- [ ] Dependency audit reviewed, including routines, RLS, publications and external consumers.
- [ ] Migration checksums and full drift SQL reviewed.
- [ ] Proposed forward migration peer-reviewed and approved.
- [ ] Disposable clone rehearsal passes with no unexpected schema changes.
- [ ] `prisma migrate status`, schema diff, integration tests and authorization tests pass on clone.
- [ ] Separate approval obtained before **any** change to migration-test; separate release approval required for actual Preview and production.

**No SQL in this document mutates database state.** Existing environments and GitHub `main` must remain unchanged throughout this review.
