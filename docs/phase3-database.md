# Phase 3 — Persistent Intelligence (Supabase + Prisma)

This project uses **PostgreSQL via Supabase** and **Prisma 6** as the only ORM
(`prisma@6` / `@prisma/client@6` — Prisma 7 requires a different config style; we stay on v6 for stable `url`/`directUrl` support).

## Local setup

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **Project Settings → Database → Connection string**.
3. Copy:
   - **Transaction** pooler URI (port `6543`) → `DATABASE_URL` (append `?pgbouncer=true` if missing)
   - **Session** pooler or **Direct** URI (port `5432`) → `DIRECT_URL`
4. Add to `.env.local` (never commit secrets):

```env
DATABASE_URL="postgresql://postgres.xxxx:YOUR_PASSWORD@aws-0-....pooler.supabase.com:6543/postgres?pgbouncer=true"
DIRECT_URL="postgresql://postgres.xxxx:YOUR_PASSWORD@aws-0-....pooler.supabase.com:5432/postgres"
STORE_RAW_ANSWERS=true
```

5. Generate client + apply schema:

```bash
npx prisma generate
npx prisma migrate dev --name phase3_persistent_intelligence
```

If migrate is awkward on Windows networking, `npx prisma db push` also works for early setup.

6. Restart `npm run dev`.

## Vercel

1. Project → **Settings → Environment Variables**
2. Add for Production + Preview:
   - `DATABASE_URL` (pooler / 6543 + `pgbouncer=true`)
   - `DIRECT_URL` (5432)
   - `STORE_RAW_ANSWERS` (`true` or `false`)
3. Ensure build runs `prisma generate` (see `postinstall` in `package.json`).
4. Run migrations against production once from your machine:

```bash
npx prisma migrate deploy
```

(Uses `DIRECT_URL` for migrate when configured in `schema.prisma`.)

## Behavior without a database

- `/api/visibility/v2` still returns Phase 1 + 2 results.
- Persistence is skipped with `persistence.saved=false` / `reason: database_not_configured`.
- `/api/audits*` returns `503` until `DATABASE_URL` is set.

## Phase 6 — Continuous monitoring

1. Apply migration `20260813000000_phase6_monitoring`.
2. Set `CRON_SECRET` in Vercel (and `.env.local` for local curl tests).
3. `vercel.json` schedules hourly: `POST /api/internal/monitoring/run`.
4. Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when `CRON_SECRET` is configured in the project.

Local cron smoke test:

```bash
curl -X POST http://localhost:3000/api/internal/monitoring/run ^
  -H "Authorization: Bearer %CRON_SECRET%"
```

Monitoring APIs (Clerk + ownership):

| Method | Path |
|--------|------|
| GET/POST | `/api/monitoring` |
| PATCH/DELETE | `/api/monitoring/:id` |
| GET/PATCH | `/api/alerts` |
| POST | `/api/internal/monitoring/run` |

## Ownership model

- Workspace is keyed by **Clerk `userId`** (server-derived).
- Clients never supply `workspaceId` / `userId` for authorization.
- Website and audit reads are scoped through `workspace.clerkUserId`.

## APIs

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/audits` | List own audits |
| POST | `/api/audits` | Persist a v2 payload (optional; v2 auto-saves) |
| GET | `/api/audits/:id` | Audit detail |
| GET | `/api/audits/:id/compare/:previousId` | Historical delta |

## MCP API keys (Phase A)

Additive table `ApiKey` (migration `20260818000000_phase_mcp_v1_api_keys`). Keys belong to `Workspace` (same Clerk identity). Secrets are HMAC-SHA256 hashed with `MCP_KEY_PEPPER`; plaintext is shown once at `POST /api/mcp/keys`. Management routes and `POST /mcp` return 404 unless `MCP_ENABLED=true`. Phase B exposes a stateless Streamable HTTP MCP server with `get_account_status` only.

## Not in Phase 3

- Weekly cron / scheduled audits
- Billing
- Polished dashboard
- Auto-fix / ChatGPT Apps
