# Production launch checklist (Phase 7.1)

Use this before public launch. **Never put real secrets in this file or in git.**

## Required Vercel environment variables

### Database
- `DATABASE_URL` — pooled Postgres (runtime)
- `DIRECT_URL` — direct/session URL (migrations)

### Auth
- Clerk keys as already configured for production (`CLERK_SECRET_KEY`, publishable key, etc.)
- Production domain allowlisted in Clerk Dashboard

### Cron
- `CRON_SECRET` — strong random secret (**never** `NEXT_PUBLIC_`)
- Vercel Cron hits `POST /api/internal/monitoring/run` with `Authorization: Bearer <CRON_SECRET>`

### Billing (provider-agnostic; do not invent processor keys)
- Canonical public price is **$19/month** (`BILLING_PRO_MONTHLY_CENTS=1900`)
- Optional display overrides:
  - `BILLING_PRO_CURRENCY=USD`
  - `BILLING_PRO_MONTHLY_CENTS=1900`
  - `BILLING_PRO_MONTHLY_DISPLAY=19`
- Historical webhook adapter env (only if still processing existing events; not shown in UI):
  - `RAZORPAY_KEY_ID`
  - `RAZORPAY_KEY_SECRET`
  - `RAZORPAY_WEBHOOK_SECRET`
  - `RAZORPAY_PLAN_ID_PRO`

Webhook URL (production, historical adapter):

`https://<your-production-domain>/api/billing/webhook`

### AI providers
- `AICREDITS_BASE_URL`
- `AICREDITS_API_KEY` (and related AICredits keys your gateways require)
- `GEMINI_API_KEY`

### Optional product flags
- `STORE_RAW_ANSWERS=true|false`

### MCP (Phase E — keep disabled)
Keep **disabled** until a pepper is set. Never prefix with `NEXT_PUBLIC_`.
- `MCP_ENABLED=false` — must be exactly `true` to expose `POST /mcp` and `GET/POST /api/mcp/keys` / `DELETE /api/mcp/keys/:id`. Default off.
- `MCP_KEY_PEPPER=` — HMAC-SHA256 pepper for API-key hashes. Required to authenticate MCP. Rotating it invalidates all keys. Never commit a real value.
- Apply rate-bucket migration `20260818220000_phase_mcp_v1_rate_buckets` before enabling.

### Email (if lead/alerts email enabled)
- Resend / SMTP keys as already used by the app

## Deploy steps

1. Set all env vars on the **Production** Vercel environment (not only Preview).
2. Run Prisma migrations against production: `npx prisma migrate deploy`.
3. Confirm `vercel.json` cron is deployed.
4. Confirm Pro public price is $19/month on `/pricing` and `/billing`.
5. Confirm email verification / login does **not** show Active Pro.
6. Smoke-test auth, Free audit, and that checkout does not grant Pro without payment.
7. Confirm Clerk production instance + domain.

## Security reminders

- Never trust client-supplied `plan`, `paid`, `workspaceId`, or amounts.
- Pro requires a verified provider subscription (`active` + `providerSubscriptionId`). Clerk `paid` / email verification never grants Pro.
- Cron and webhooks must reject missing/invalid secrets.

## Related docs

- `docs/phase7-billing.md`
- `docs/production-smoke-test.md`
- `docs/analytics-events.md`

MCP key management (`/api/mcp/keys`) and `POST /mcp` stay **404** while `MCP_ENABLED` is not `true`.
