/**
 * Seeds the real catalog into a throwaway embedded Postgres, crawls it twice and
 * filters it, proving persistence, idempotency and filter behavior without Docker.
 * Reads public job boards only. With LIVE_MATCH_JOBS=n it also matches n real jobs
 * against the local Ollama.
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
    return execFileSync("npx", ["tsx", "src/worker/cli.ts", ...args], { env: { ...process.env, DATABASE_URL: url, LOG_LEVEL: process.env.LOG_LEVEL ?? "warn" }, encoding: "utf8", timeout: 900_000 });
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

  console.log("EVALUATE", worker("evaluate").slice(-500));
  console.log("EVALUATE AGAIN", worker("evaluate").slice(-500));
  console.log("PENDING", worker("pending").slice(-300));
  const reasons = await client.query(
    "SELECT decision, unnest(reason_codes) reason, count(*)::int n FROM job_evaluations GROUP BY 1, 2 ORDER BY 1, 3 DESC",
  );
  console.table(reasons.rows);
  const eligible = await client.query(
    `SELECT t.priority, co.name company, c.title, e.reason_codes[1] reason
       FROM match_tasks t JOIN canonical_jobs c ON c.id = t.canonical_job_id JOIN companies co ON co.id = c.company_id
       JOIN job_evaluations e ON e.canonical_job_id = c.id ORDER BY t.priority DESC, t.id DESC`,
  );
  console.table(eligible.rows);

  const jobs = Number(process.env.LIVE_MATCH_JOBS ?? 0);
  if (jobs > 0) {
    process.env.MAX_AI_JOBS_PER_RUN = String(jobs);
    process.env.LOG_LEVEL = "info";
    console.log("MATCH", worker("match", "--trigger", "manual").slice(-6000));
    const results = await client.query(
      `SELECT r.score, r.recommendation, c.title, r.duration_ms, r.model_calls, r.input_truncated, r.input_estimated_tokens,
              r.validation_outcome, r.evidence_literal || '/' || r.evidence_total evidence, r.response->>'role_category' role
         FROM current_matches r JOIN canonical_jobs c ON c.id = r.canonical_job_id ORDER BY r.score DESC`,
    );
    console.table(results.rows);
    console.log((await client.query("SELECT status, attempts, last_error_kind, count(*)::int n FROM match_tasks GROUP BY 1, 2, 3")).rows);
  }
} finally {
  await client.end().catch(() => {});
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
}
