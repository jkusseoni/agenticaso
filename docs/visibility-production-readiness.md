# Visibility billing and recovery — production readiness checklist

**Status: NOT READY / HOLD**  
**Scope:** `fix/visibility-settlement-safety` draft PR. This checklist does not approve merging, migrating production data, or enabling the new adapter.

## Verified in feature-branch CI

- [x] Prisma schema validates and migrations apply to disposable PostgreSQL.
- [x] Idempotent reservation, settlement and release integration tests.
- [x] Concurrent settlement/release tests and lost-response retry tests.
- [x] Opt-in HTTP handler integration tests with real PostgreSQL.
- [x] HOLD review recording, operation row lock, workspace-scoped history and database constraints.
- [x] Recovery review parent deletion is restricted while review records exist.
- [x] Existing safety test suite and disposable PostgreSQL job pass (Run #60).
- [x] Read-only recovery inspection is available in library code.
- [x] Recovery retention risks documented in `docs/visibility-recovery-retention.md`.

## Blocking items — do not enable in production

- [ ] **Migration plan:** review migration history against the real production schema, backup and restore process, rollback plan, maintenance window and staging rehearsal. Disposable CI PostgreSQL is not production validation.
- [ ] **Cutover design:** production HTTP route currently uses legacy usage functions by default; `usageSessionFactory` is opt-in. Define safe activation, rollback and mixed-version behavior. Do not silently enable it.
- [ ] **Historical usage reconciliation:** verify existing billing counters, periods, in-flight reservations and monthly boundaries; specify treatment of old requests during cutover.
- [ ] **Security authorization:** establish and test reviewer identity, admin RBAC, workspace isolation, and audit access before adding any administrative API.
  - **Review finding (2026-10-26):** `recordVisibilityRecoveryHold(prisma, input)` accepts `reviewerId` supplied by its caller and validates only nonblank text. It does **not** authenticate the reviewer or check admin role/permissions. The operation/workspace row check protects tenant association, but is not authorization. Keep this function private to trusted server code; do not expose it through a route, MCP tool, cron, or user-controlled action until identity is derived from a verified server session and explicit admin permission checks are implemented and tested. Cover non-admin, unauthenticated, cross-workspace, spoofed reviewerId, and denied audit-history access in integration tests.
- [ ] **Audit integrity and privacy:** approve retention duration, deletion/expiry policy, privilege boundaries, tamper-evidence or append-only enforcement, and lawful data deletion procedure.
- [ ] **Recovery operations:** define documented manual procedure for ambiguous settlement outcomes; never auto-release stale reservations based solely on age.
- [ ] **Operational observability:** structured logs without secrets/PII, metrics for stuck reservations and settlement failures, alert thresholds and runbook.
- [ ] **Rollout controls:** feature flag or equivalent, small-scope rollout, kill switch, monitoring, explicit owner sign-off.
- [ ] **Production verification:** end-to-end billing/payment and entitlement tests, rate/limit abuse tests, staging load/concurrency tests, migration dry run and incident rollback rehearsal.
- [ ] **PR review:** independent code/security review, review of all changed migrations, green CI at final SHA and explicit merge authorization.

## Suggested safe rollout order

1. Confirm business/legal retention and authorized deletion requirements.
2. Complete security review and reviewer RBAC design; add failing tests before any admin route.
3. Validate migrations and production-schema compatibility on a staging clone without exposing customer data.
4. Reconcile old/new usage semantics and implement a reversible activation switch.
5. Run full integration and fault-injection tests, including ambiguous provider response and mid-cutover traffic.
6. Obtain explicit authorization for PR merge, production migration, and feature activation **as separate decisions**.

## Notes

Passing CI demonstrates only the tests covered by the feature-branch workflow. It does not establish production readiness, complete integration coverage, or compliance. Existing production billing remains unchanged until explicitly authorized and activated.
