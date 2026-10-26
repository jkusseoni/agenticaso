# Recovery PostgreSQL least-privilege role design

**Status: DESIGN ONLY — HOLD.** No production SQL, role, credential, API, or migration is activated by this document.

## Roles and trust boundaries

| Role | Purpose | Proposed allowed operations | Explicitly prohibited |
| --- | --- | --- | --- |
| Migration owner | Run reviewed schema changes and tightly controlled retention maintenance | DDL under change control | Request traffic, routine application sessions |
| Application runtime | Serve authenticated requests and use Prisma | Minimum SELECT/INSERT/UPDATE on required operational tables; scoped recovery grant changes only behind server-side operator authorization | CREATE/ALTER/DROP, trigger management, GRANT, DELETE/UPDATE on grant audit |
| Recovery audit reader | Investigate approved recovery incidents | SELECT on narrowly scoped audit records | Any audit mutation or grant change |
| Retention operator | Execute separately approved expiry/privacy process | Explicitly reviewed maintenance procedure with logged approvals | Interactive customer traffic and blanket permanent audit bypass |

**Caution:** Table-level PostgreSQL grants do not enforce per-workspace or per-operator authorization. The existing Clerk identity + independent operator allowlist must remain the application boundary. Consider RLS only after reviewing the connection-pool identity propagation and transaction scoping; do not assume a shared Prisma connection carries a trusted actor ID.

## Proposed table permissions

- `VisibilityRecoveryGrantAudit`: request-serving role may need INSERT for grant/revoke transactions, but must not have UPDATE or DELETE. Audit reader receives SELECT only. Existing immutable trigger remains defense-in-depth.
- `VisibilityRecoveryAdminGrant`: runtime SELECT and necessary INSERT/UPDATE for explicitly authorized grant changes; DELETE is not required for normal revocation (revocation disables the row). Do not create an initial privileged operator.
- `VisibilityRecoveryReview`: runtime needs INSERT for authorized HOLD records and SELECT for authorized history; no normal UPDATE/DELETE. **Current disposable test cleanup uses DELETE**, so introduce a separate test cleanup/migration owner role before enforcing this policy.
- `VisibilityUsageOperation`, `UsagePeriod`, and `Workspace`: preserve only privileges required by audited reservation/settlement/ownership code paths; avoid blanket REVOKE until staging verifies all Prisma calls.

## Implementation sequence (future change)

1. Inventory production roles, owners, `has_table_privilege` results, connection pooling, and the active Prisma runtime credential. Never print secrets.
2. Create disposable PostgreSQL roles for migration owner and restricted runtime, then apply candidate grants in a test-only setup.
3. Test runtime INSERT/SELECT paths for authorized HOLD and grant/revoke; verify SQL UPDATE/DELETE of both audit tables is denied, and schema/trigger modification is denied.
4. Test retention maintenance using a separately privileged identity, including review parent `ON DELETE RESTRICT`, and verify a failure does not partially delete data.
5. Validate behavior through both direct PostgreSQL and Prisma with the restricted role; test denied permissions without accidentally bypassing them using the migration owner.
6. Rehearse a reviewed migration and rollback on staging with production-like roles and data. Require explicit approval before any production change.

## Rollback and safety

- Keep the existing production credential and route unchanged until staging is validated.
- Do not automatically release ambiguous visibility holds, reset usage counters, or alter billing entitlements.
- A permission rollout must be reversible by an authorized migration owner, without widening privileges to public roles.
- Monitor authorization denials and migration errors without logging Clerk identifiers, database credentials, or customer evidence.

**Exit criteria:** security owner approves role matrix and retention policy; disposable two-role tests pass; staging backup/restore and cutover checks pass; PR review explicitly authorizes a future production migration. Current PR and deployment remain HOLD.
