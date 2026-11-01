/**
 * Seeds the real catalog into a throwaway embedded Postgres and crawls it twice,
 * proving persistence and idempotency without Docker. Reads public job boards only.
 */
import EmbeddedPostgres from "embedded-postgres";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const dir = mkdtempSync(join(tmpdir(), "hh-live-"));
const port = 54999;
const server = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: false, onLog: () => {} });
await server.initialise();
await server.start();
await server.createDatabase("live");
const url = `postgres://postgres:postgres@localhost:${port}/live`;
const worker = (...args: string[]) => {
  try {
    return execFileSync("npx", ["tsx", "src/worker/cli.ts", ...args], { env: { ...process.env, DATABASE_URL: url, LOG_LEVEL: "warn" }, encoding: "utf8", timeout: 400_000 });
  } catch (error) {
    return `FAILED ${(error as { status?: number }).status}\n${(error as { stdout?: string }).stdout}\n${(error as { stderr?: string }).stderr}`;
  }
};
const client = new pg.Client(url);
const counts = async () => {
  const one = async (sql: string) => (await client.query(sql)).rows[0].n;
  return {
    canonical: await one("SELECT count(*)::int n FROM canonical_jobs"),
    listings: await one("SELECT count(*)::int n FROM source_listings"),
    active: await one("SELECT count(*)::int n FROM source_listings WHERE status='active'"),
    snapshots: await one("SELECT count(*)::int n FROM source_snapshots"),
    events: await one("SELECT count(*)::int n FROM job_events"),
    dupKeys: await one("SELECT count(*)::int n FROM (SELECT source_id, provider_job_id FROM source_listings GROUP BY 1,2 HAVING count(*)>1) d"),
  };
};
try {
  console.log("MIGRATE", worker("migrate").trim().slice(-300));
  console.log("SEED", worker("seed").trim().slice(-300));
  await client.connect();
  for (const label of ["first", "second"]) {
    const started = Date.now();
    const out = worker("crawl", "--trigger", "manual");
    console.log(label.toUpperCase(), Date.now() - started, "ms");
    console.log(out.slice(-3500));
    console.log(label, "counts", await counts());
  }
  const byOutcome = await client.query("SELECT outcome, count(*)::int n FROM source_snapshots GROUP BY 1 ORDER BY 1");
  console.log(byOutcome.rows);
  const sample = await client.query("SELECT title, company_id FROM canonical_jobs ORDER BY id LIMIT 5");
  console.log(sample.rows);
  const qa = await client.query("SELECT count(*)::int n FROM canonical_jobs WHERE title ~* '(qa|quality|test|sdet|בדיק)'");
  console.log("qa-ish titles", qa.rows[0].n);
} finally {
  await client.end().catch(() => {});
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
}
