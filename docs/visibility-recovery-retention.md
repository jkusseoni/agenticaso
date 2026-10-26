# Visibility recovery audit retention — pre-production review

**Status: HOLD.** This document describes the current implementation and unresolved decisions. It does not authorize production activation, data deletion, or automatic recovery.

## Current controls

- `VisibilityRecoveryReview` stores a HOLD decision, reviewer ID, reason, evidence references, operation ID, workspace ID, and creation time.
- Database constraints require HOLD-only decisions and nonempty evidence.
- The review-writing function locks the visibility operation row and requires its status to be `reserved`.
- Review-history reads are scoped by operation and workspace.
- Review foreign keys use `ON DELETE RESTRICT` to prevent deletion of an operation or workspace that has dependent reviews.
- The integration test cleanup explicitly deletes test review rows before deleting its test workspace. **That exception is for disposable CI data only.**
- There are **no append-only UPDATE/DELETE triggers**. Privileged database writers can still change or delete reviews. The history is therefore **not tamper-proof**.
- There is no authorized production deletion or retention-expiry workflow, and no automatic settle/release workflow.

## Required decisions before production

1. Set an approved retention period and deletion basis for recovery evidence, accounting for applicable legal, tax, privacy, and contractual requirements. Do not assume indefinite retention.
2. Decide how workspace deletion requests interact with retained billing records: minimize or pseudonymize personal identifiers where legally appropriate, and document any permitted exceptions.
3. Define database privileges and a restricted deletion procedure. A privileged maintenance role may be necessary for approved expiry, but must not be accessible to request handlers.
4. Define how review changes are prevented or independently detected (append-only privileges/triggers, external audit log, or equivalent), with an explicit migration and rollback plan.
5. Add integration tests for authorized retention expiry, denied ordinary deletion, concurrent review/settlement, and CI-only cleanup.
6. Complete a security/privacy review before enabling any admin endpoint or production recovery action.

## Operational rule

Until the above are approved and tested, only read-only inspection and non-executable HOLD review recording are implemented. Do not infer that a stale reservation is safe to release; a provider call may have completed even when its response was lost.
