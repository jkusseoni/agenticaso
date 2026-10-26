# Visibility billing cutover plan (design only)

**Status: HOLD — no production activation authorized.**  
Scope: the homepage visibility check in `lib/visibility/handler.js`. This document does not switch any route, merge a PR, or apply production migrations.

## Legacy and new behavior

| Concern | Legacy default | New opt-in session |
| --- | --- | --- |
| Reservation | `reserveUsage(prisma, workspaceId, {aiTests,limit}, periodAt)` | `session.reserve({aiTests,limit,now:periodAt})` |
| Identity | Workspace + usage period; no operation identity | Unique `operationId` bound to workspace and usage period |
| Settlement | `commitUsage` updates counters by reserved/actual quantities | `settleVisibilityOperation` transitions operation to committed |
| Retry safety | Settlement re-read errors are suppressed, but repeated SQL settlement is not operation-idempotent | `already_committed` returns without recharging |
| Release | `releaseUsage` decrements held counter by amount | `releaseVisibilityOperation` transitions operation to released |
| Ambiguous settlement | Caller may not know whether SQL succeeded | Session refuses release once settlement is attempted; manual review may be required |
| Monthly boundary | Handler passes the original `periodAt` | Operation is attached to the period chosen during reserve |
| Production activation | Default today | Only when a `usageSessionFactory` is explicitly injected |

## Critical cutover invariants

1. **Never migrate in-flight legacy reservations into new operation rows without an audited reconciliation.** Legacy reservations have no operation ID; inventing one does not prove their provider outcome.
2. **Do not double-charge or double-release.** A request must use one billing implementation from reservation through finalization, even if a rollout flag changes mid-request.
3. **Do not reset existing usage counters.** The new ledger writes to the same `UsagePeriod` counters. Mixed old/new traffic must share allowance checks and concurrency limits.
4. **Keep retries on the same operation ID.** The current adapter creates a UUID per session; cross-request idempotency requires an authenticated, bounded operation-key design if it is ever added.
5. **Do not auto-release ambiguous holds.** A timeout or lost settlement response is not proof that no provider work occurred.
6. **Never enable a production route solely because feature-branch CI passed.** Production schema, rollback, payment/entitlement behavior and monitoring must be checked independently.

## Proposed reversible activation (future implementation)

- Introduce a server-only, explicit billing-mode switch with a safe legacy default. Do not read mode from client input or expose it as an unauthenticated API parameter.
- Resolve mode **once before reservation** and retain that mode for the entire request. Do not switch modes during retries.
- On disabled or invalid configuration, retain the legacy path (or fail closed if the environment is intentionally configured for strict new-ledger-only operation).
- Roll back by disabling **new reservations** through the new mode, not by undoing committed usage or deleting operation records.
- Existing new-ledger operations must remain queryable and reconcilable after rollback; retain their migrations and review records.

## Required test matrix before activation

- Legacy default request and quota behavior unchanged.
- Opt-in new-ledger successful request, partial provider success, cancellation, timeout and provider failure.
- Duplicate settlement and lost response do not charge twice.
- Mixed-mode concurrent requests cannot overspend a shared monthly limit.
- UTC month-boundary crossing, plan change and exhausted allowance.
- Stale reserved operations: manual review only, no automatic release.
- Mid-flight flag toggle: each request completes in its original mode.
- Simulated rollback: new requests return to legacy; existing operation records remain intact.
- Production-like staging migration and restore rehearsal.

## Go/no-go

**NO-GO** until an independent reviewer signs off on migration/rollback, authorization, audit retention, operational monitoring and all tests above. Merging, production migration and switching billing mode are three separate approval decisions.
