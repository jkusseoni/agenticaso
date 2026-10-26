# Verify Vercel Preview database identity (private operator workflow)

**Status: not yet executed.** This verification does not approve migrations, production rollout, or merging the draft PR.

## What was added

`scripts/verify-preview-db.mjs` uses the configured Prisma `DATABASE_URL` to issue one read-only `SELECT current_database(), current_user` and checks that:

- `DATABASE_URL` and `DIRECT_URL` identify the same database and Neon endpoint (allowing the runtime `-pooler` host variation).
- The endpoint matches `EXPECTED_STAGING_DB_HOST`, which the operator must independently copy **as a hostname only** from the `agenticaso-test` Neon connection details. Do not supply a connection URL or password.
- `VERCEL_ENV` is not `production`.
- The actual connected database matches the configured database.

The script prints only pass/fail messages, database name, and role. It does not print URLs, hosts, or passwords. It must run privately, not through a web route.

## Operator procedure

1. Confirm the Neon `agenticaso-test` project and expected `neondb` database. Obtain the endpoint **hostname** from its connection details; do not post connection strings.
2. On a trusted workstation, pull only the Vercel **Preview** environment variables using the official Vercel CLI (never pull Production). Ensure the selected Vercel project is `agenticaso`.
3. Load the Preview variables in a private process, set `EXPECTED_STAGING_DB_HOST` to the independently verified test endpoint hostname, and set `VERCEL_ENV=preview`. Run `node scripts/verify-preview-db.mjs` using Node 24 and installed project dependencies.
4. Verify the output shows the expected database `neondb`. Compare the role against the planned restricted runtime role; `neondb_owner` indicates owner-level privileges and is not least-privilege.
5. If verification fails, stop. Do not guess or overwrite Vercel environment variables. Check the selected Vercel environment and Neon endpoint in their dashboards without disclosing secrets.

**Important:** A matching endpoint establishes connection target identity, not whether the Neon project is entirely isolated from production services, whether old test data is safe to modify, or whether the runtime role has least privilege. Those remain separate staging readiness gates.

## Security boundary

- Do not paste `.env` contents, `DATABASE_URL`, `DIRECT_URL`, connection strings, API keys, or tokens into chat, logs, screenshots, or GitHub.
- The script does not write to the database and does not deploy to Vercel.
- Do not run migrations until isolation, backup/restore, and role separation have been reviewed.
