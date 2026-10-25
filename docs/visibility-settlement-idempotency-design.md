# Durable AI visibility usage settlement — design gate

Status: **DESIGN ONLY / NOT DEPLOYABLE**. The existing `commitUsage` and `releaseUsage` APIs are used by more than Visibility; do not change their behavior globally without auditing every caller.

## Verified current behavior
- `UsagePeriod` stores aggregate `aiTests` and `aiTestsReserved` only.
- `commitUsage` increments usage with an unconditional SQL UPDATE. A repeated commit can increment usage again.
- The Visibility handler retries commit and release. An ambiguous database acknowledgment cannot be safely resolved from aggregate counters.
- Current mock tests simulate failure *before* SQL applies and failure of a *post-update read*, but not loss of acknowledgment after the SQL UPDATE commits.

## Proposed contract
1. Allocate one unpredictable, unique `operationId` for each Visibility reservation **before** charging a hold. Never regenerate it on retry.
2. Persist a reservation record with `operationId`, `workspaceId`, `usagePeriodId`, `reservedAiTests`, `actualAiTests`, and a constrained state (`reserved`, `committed`, `released`). Enforce uniqueness of `operationId` in PostgreSQL.
3. Reserve atomically: in a single database transaction create the operation and conditionally increment the period hold under the allowance limit. Duplicate operation IDs must return the persisted state rather than reserve twice.
4. Commit atomically: conditional state transition `reserved -> committed` and aggregate counter updates in the **same transaction**. Repeated commits for the same operation must return `already_committed` without updating counters. Reject a conflicting actual amount.
5. Release atomically: conditional state transition `reserved -> released` and decrement the hold in the same transaction. A release must not reverse an already committed operation.
6. If an acknowledgment is lost, query the operation by ID and reconcile the persisted state. Do **not** blindly release a hold after an ambiguous commit failure.
7. Keep legacy aggregate helpers for unrelated callers until those call sites are individually migrated.

## Required disposable PostgreSQL integration tests
- Same operation committed twice -> exactly one increment.
- SQL transaction committed but client receives an error -> reconciliation finds `committed` and does not retry the increment.
- Concurrent duplicate commit requests -> exactly one transition.
- Commit racing release -> exactly one terminal state, no negative holds.
- Retry reserve with same ID -> one hold only.
- Wrong workspace/period/amount -> rejected without modifying counters.
- UTC month rollover -> original period used.
- A failed pre-commit transaction -> reservation remains available for safe retry.
- A new migration against a database with existing UsagePeriod records -> no data loss.

## Rollout gates
- Review all callers of `reserveUsage`, `commitUsage`, `releaseUsage`, and `consumeUsage`.
- Review the Prisma schema, SQL migration, and indexes before applying to any persistent database.
- Run existing Node tests and disposable PostgreSQL integration tests; verify GitHub Actions success.
- Only then propose a reviewed merge. No production migration, deployment, or G5-E execution is authorized by this document.
