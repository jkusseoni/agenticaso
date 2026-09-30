/**
 * Start a local embedded PostgreSQL, apply Prisma migrations, run Growth PG tests.
 * Never reads or writes the Neon URL from .env.local for migrate/test (overrides env).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { isDisposableGrowthTestUrl } from "../lib/growth/test-db-url.js";

function run(cmd, args, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, ...extraEnv },
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
    });
  });
}

async function main() {
  if (process.env.GROWTH_TEST_DATABASE_URL && isDisposableGrowthTestUrl(process.env.GROWTH_TEST_DATABASE_URL)) {
    const url = process.env.GROWTH_TEST_DATABASE_URL;
    await run("npx", ["prisma", "migrate", "deploy"], { DATABASE_URL: url, DIRECT_URL: url });
    await run("npx", ["prisma", "generate"], { DATABASE_URL: url, DIRECT_URL: url });
    await run("node", ["--test", "lib/growth/__tests__/postgres.integration.test.js"], {
      GROWTH_TEST_DATABASE_URL: url,
      DATABASE_URL: url,
      DIRECT_URL: url,
    });
    return;
  }

  let EmbeddedPostgres;
  try {
    ({ default: EmbeddedPostgres } = await import("embedded-postgres"));
  } catch {
    console.error("No disposable Postgres. Set GROWTH_TEST_DATABASE_URL to postgresql://...@127.0.0.1/...growth_test...");
    process.exit(2);
  }

  const port = 55432;
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(process.cwd(), ".growth-pg-data"),
    user: "postgres",
    password: "password",
    port,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase("agenticaso_growth_test");
    const url = `postgresql://postgres:password@127.0.0.1:${port}/agenticaso_growth_test`;
    if (!isDisposableGrowthTestUrl(url)) throw new Error("refusing non-disposable test url");
    await run("npx", ["prisma", "migrate", "deploy"], { DATABASE_URL: url, DIRECT_URL: url });
    await run("npx", ["prisma", "generate"], { DATABASE_URL: url, DIRECT_URL: url });
    await run("node", ["--test", "lib/growth/__tests__/postgres.integration.test.js"], {
      GROWTH_TEST_DATABASE_URL: url,
      DATABASE_URL: url,
      DIRECT_URL: url,
    });
  } finally {
    await pg.stop();
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
