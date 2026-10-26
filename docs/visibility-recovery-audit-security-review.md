# Recovery audit integrity — security review (2026-10-26)

**Decision: HOLD.** This review does not approve production migration, grant bootstrap, administrative API exposure, or PR merge.

## Verified repository controls

- `VisibilityRecoveryGrantAudit` has a PostgreSQL `BEFORE UPDATE OR DELETE` trigger installed by migration `20261026010000_visibility_recovery_grant_audit`; integration tests attempt both mutations.
- `VisibilityRecoveryReview` has parent foreign keys using `ON DELETE RESTRICT` (migration `20261025210000_visibility_recovery_review_retention`), but **no UPDATE/DELETE immutability trigger**. The integration suite deliberately deletes review rows in disposable test cleanup.
- Grant writes are wrapped in a transaction with an operator authorization callback and grant audit insertion. A verified Clerk adapter and independently controlled allowlist are available as server-only components.
- None of these database protections establish that the production application role has least-privilege SQL grants. A table trigger is not a substitute for independent audit storage or restricted migration ownership.

## Production blockers

1. Inspect actual production and staging PostgreSQL roles, table privileges, ownership, and migration privileges. Ensure the request-serving role cannot disable triggers, alter schema, or administer audit retention.
2. Agree on review-record retention, deletion authority, privacy requests, and backup/restore behavior **before** adding an immutability trigger to `VisibilityRecoveryReview`. The current disposable integration cleanup relies on DELETE.
3. Design a restricted retention-maintenance path separate from application request credentials, and test it in staging.
4. Add database-level denial tests using a **separate least-privilege application role**, not just the migration-owner role. Include denied audit UPDATE/DELETE and unauthorized grant mutation.
5. Rehearse migration and rollback on a staging clone, verify existing data and backups, and document recovery procedures.

## Risk boundary

Do not describe recovery review history as tamper-proof. `ON DELETE RESTRICT` prevents deleting parent rows while child reviews exist; it does not stop direct edits or deletions of the child rows. The grant audit trigger prevents ordinary UPDATE/DELETE through the current database path, but privileged database owners may be able to bypass or remove it.

**Next implementation gate:** approve retention and least-privilege role design, then introduce a migration plus two-role PostgreSQL tests in a separate reviewed change. Until then, preserve the existing production HOLD.
