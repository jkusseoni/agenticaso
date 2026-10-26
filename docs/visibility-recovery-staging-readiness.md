# Visibility recovery staging readiness checklist

**Status: NOT READY — HOLD (2026-10-26).** This is a planning gate, not approval to deploy, migrate, merge, change credentials, or delete records.

## Current verified baseline

- Draft PR #1 targets `fix/billing-visibility-preview` from `fix/visibility-settlement-safety`, not `main`.
- GitHub Actions run 40257426738 passed both the safety and disposable PostgreSQL integration jobs for commit `eb82cd8`.
- Disposable CI validates migrations and a restricted role test. It does **not** verify production/staging credential separation, backup restore, actual access grants, or real traffic.
- Grant audit has an immutable UPDATE/DELETE trigger; recovery review history lacks one and requires an approved retention design.

## Staging entry checklist (all must be verified)

- [ ] Identify isolated staging Vercel environment and Neon database branch; confirm no production credentials, billing webhooks, customer notifications, or real payment actions.
- [ ] Record exact staging migration and runtime database roles, table ownership, grants, schema privileges, and pooler behavior without printing secrets.
- [ ] Confirm an approved recovery-review retention period, deletion basis, access restrictions, and privacy-request handling.
- [ ] Capture an encrypted staging backup and perform a **restore into a separate disposable database**; verify schema, record counts, and representative operation ledger integrity.
- [ ] Apply reviewed Prisma migrations to staging with migration-only credentials; verify runtime role cannot perform DDL or mutate audit records.
- [ ] Execute authorized HOLD review, grant/revoke, audit reads, and denied cross-workspace access under staging runtime credentials.
- [ ] Simulate lost provider/settlement responses; verify no duplicate billing charge and no automatic release of ambiguous holds.
- [ ] Exercise documented rollback on a disposable clone. Avoid assuming destructive Prisma migration rollback is automatic.
- [ ] Review logs for secrets/PII, confirm operational alerts and access audit coverage, and document incident contacts.
- [ ] Obtain explicit security/privacy and deployment approval before removing Draft status or merging.

## Required evidence

For each item, capture: test environment identifier, redacted command or workflow, commit SHA, result, reviewer, and timestamp. Do not paste passwords, connection URLs containing credentials, customer records, or authentication tokens into issues or CI logs.

## Stop conditions

Any cross-workspace disclosure, unauthorized grant, audit mutation, missing backup restore, migration drift, failed role isolation, duplicate charge, or uncertain billing reconciliation blocks rollout. Preserve the current **HOLD**.

## Next step

Obtain staging environment identifiers and role/retention decisions from the owner. Then implement an isolated staging rehearsal plan; **do not** run migrations against unknown databases.
