# Production smoke test (manual)

Perform after env is configured. Real payment verification is done against the payment provider — email verification must not activate Pro.

## A. Free signup
- [ ] Sign up / sign in via Clerk on production domain
- [ ] Land on dashboard or home without errors
- [ ] After email verification, `/api/billing/status` is Free (`isPaid: false`), not Active Pro

## B. Free audit
- [ ] Run a Free-tier visibility check (v2) within Free buyer-question / AI-test limits
- [ ] See useful scores / evidence (not a blank paywall for the whole result)

## C. Limit reached
- [ ] Exhaust Free AI-test or question allowance
- [ ] Next audit returns structured upgrade response (402), no partial paid provider spend after rejection

## D. Upgrade screen
- [ ] `/pricing` and `/billing` show Pro price from billing config (canonical $19/month unless overridden)
- [ ] No ₹499, ₹1,499, or Razorpay copy in billing/pricing/dashboard UI

## E. Checkout
- [ ] Signed-in Free user calling `POST /api/billing/checkout` does **not** become Pro
- [ ] No unpaid `trialing` subscription is written as paid access

## F. Webhook (historical / future provider)
- [ ] Invalid signature → 400
- [ ] Duplicate event id → idempotent (no double provision)

## G. Pro activation
- [ ] Only after a **verified successful payment** does `/api/billing/status` show Pro / active
- [ ] Login and email verification never set `isPaid: true`

## H. Pro audit
- [ ] Pro user can run larger question sets within Pro limits
- [ ] Usage counters increase by billable (successful) provider tests only

## I. Monitoring enable
- [ ] Enable weekly monitoring on an owned website
- [ ] Free user cannot enable (402 / upgrade)

## J. Cron monitoring
- [ ] With `CRON_SECRET`, `POST /api/internal/monitoring/run` processes due monitors
- [ ] Missing/invalid secret → 401
- [ ] Insufficient allowance → skip with status, no misleading alerts, monitor stays active

## K. Alert creation
- [ ] After a successful monitoring delta, alerts appear in dashboard

## L. Run Now
- [ ] Run Now uses same entitlement/usage path as cron
- [ ] Concurrent Run Now while running → `already_running` (409)

## M. Cancel subscription
- [ ] Cancel at period end from `/billing`
- [ ] Access retained until period end when applicable; data retained

## N. Expiry / downgrade
- [ ] Expired / past-due → Free entitlements
- [ ] Historical audits/websites still readable

## O. Login / email verification
- [ ] User with Clerk `paid=true` and **no** subscription row stays **Free** (no grandfathering)
- [ ] User with expired / unpaid subscription is Free even if Clerk `paid` is true
- [ ] Only a verified successful provider payment (`active` + provider subscription id) is Pro

## P. Ownership / security
- [ ] Cannot fetch another user’s audit/monitoring by guessing ids
- [ ] Client cannot set plan/price/status
- [ ] API errors never return stack traces, DB URLs, or API keys

## Q. MCP (keep disabled in production until explicitly enabled)
Automated coverage: `lib/mcp/__tests__/smoke.test.js` and `lib/mcp/__tests__/hardening.test.js`.
Do **not** set `MCP_ENABLED=true` in the repo or Vercel until a pepper is configured and a go-live is approved.

When enabled on a staging environment only:
- [ ] `MCP_ENABLED` not `true` → `POST /mcp` is 404
- [ ] Missing / invalid / revoked / expired Bearer key → 401 JSON-RPC (no Clerk redirect, no `Set-Cookie`)
- [ ] Valid key → `initialize`, `tools/list` shows exactly the six V1 tools
- [ ] `get_account_status` includes `plan`, `remaining`, and `upgradeUrl` with `utm_source=mcp`
- [ ] `scan_store` / `run_visibility_audit` reject localhost and private URLs
- [ ] Free entitlement failure returns `upgradePayload()` fields plus MCP `upgradeUrl`
- [ ] Successful MCP audit increments the same `UsagePeriod.aiTests` counter as `/api/visibility/v2`
- [ ] `/api/visibility/v2` still requires Clerk sign-in (unchanged)
