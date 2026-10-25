# Recovery HOLD authorization — Clerk integration contract

**Status: DESIGN ONLY / HOLD.** No route, privilege assignment, or production activation is authorized by this document.

## Verified code facts

- `@clerk/nextjs` is installed in package.json.
- `lib/db/ownership.js` uses a server-derived Clerk user ID for workspace ownership.
- `lib/billing/visibility-recovery-session.js` requires an injected verified-session resolver and authorizer; these are **not** wired to Clerk or any production RBAC provider.
- `recordVisibilityRecoveryHold` remains a low-level function without its own admin authorization. Never expose it directly.

## Required integration contract

1. At the server-only boundary, call Clerk's supported server auth API for the current request. Reject missing or invalid `userId`; never accept a user ID, reviewer ID, or admin role from JSON, query parameters, or client-controlled headers.
2. Obtain the reviewer privilege from a **trusted server-side** admin policy (explicit allowlist or protected role membership). Ordinary Clerk sign-in and workspace ownership do not confer recovery-admin privileges.
3. Enforce the dedicated `visibility.recovery.hold` permission and check the target workspace scope. The authorizer must return literal `true` only on success, and fail closed on lookup errors.
4. Pass the verified actor to `recordSessionVisibilityRecoveryHold`; never call `recordVisibilityRecoveryHold` directly from an HTTP route.
5. Audit-history reads need separate `visibility.recovery.read` authorization. Limit response fields and exclude evidence containing secrets or customer PII.
6. Add end-to-end tests for unauthenticated, non-admin, spoofed reviewer, cross-workspace, stale/disabled admin, failed policy lookup, and successful scoped admin cases.
7. Review whether the low-level audit function should become inaccessible outside the authorized module; repository-wide call-site review is required before production use.

## Explicit blockers

- Admin policy source, trusted role ownership, and privilege revocation procedure have not been approved.
- No production Clerk-to-RBAC adapter or admin API is implemented.
- No production schema migration, feature activation, or PR merge is approved.
