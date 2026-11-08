import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate";
import type { Pool } from "../../src/db/pool";
import { createLogger } from "../../src/logger";
import { buildMatchConfig, hashMatchConfig } from "../../src/match/config";
import { OllamaError, type ChatRequest, type ChatResult } from "../../src/match/ollama-client";
import { getJob } from "../../src/dashboard/queries";
import { claimTask, countAffordable, evaluateJobs, forceRematch, readBacklog, recoverAbandoned, retryFailedTasks } from "../../src/match/queue";
import { runMatch, type MatchDeps, type MatchOptions } from "../../src/match/runner";
import { ensureProfile, saveProfile } from "../../src/profile/store";
import { scriptedFacts } from "../scripted-facts";
import { addSource, openPool, rawListing, resetDatabase, runCrawl, scriptedConnector, snapshot, type Script } from "./helpers";

const config = buildMatchConfig({ OLLAMA_NUM_CTX: 3072, MAX_OUTPUT_TOKENS: 800, MAX_JOB_INPUT_TOKENS: 1600 });

const output = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  role_category: "qa_automation",
  matching_requirements: [{ requirement: "Automation", evidence: "Test automation" }],
  missing_requirements: [{ requirement: "Rust", evidence: "invented quote", candidate_fact: null }],
  unknown_requirements: [],
  concerns: [],
  explanation: "A good fit.",
  points: { role: 40, skills: 25, experience: 8, location: 5, industry: 2 },
  ...overrides,
});

const facts = scriptedFacts();

type Reply = string | Error | ((request: ChatRequest) => Promise<string> | string);

function fakeModel(replies: Reply[], digest: string | null | Error = config.modelDigest) {
  const calls: ChatRequest[] = [];
  const model: MatchDeps["model"] = {
    async modelDigest() {
      if (digest instanceof Error) throw digest;
      return digest;
    },
    async chat(request): Promise<ChatResult> {
      calls.push(request);
      const reply = replies.shift();
      if (reply === undefined) throw new Error("Model script exhausted");
      if (reply instanceof Error) throw reply;
      const content = typeof reply === "function" ? await reply(request) : reply;
      facts.observe(content);
      return { content, doneReason: "stop", totalMs: 1, loadMs: 0, promptTokens: 1, promptMs: 0, outputTokens: 1, outputMs: 0 };
    },
  };
  return { model, calls };
}

const options = (overrides: Partial<MatchOptions> = {}): MatchOptions => ({
  trigger: "test",
  config,
  maxJobs: 10,
  timeBudgetSeconds: 600,
  inferenceTimeoutSeconds: 180,
  maxAttempts: 3,
  retryBaseSeconds: 1800,
  ...overrides,
});

describe("matching", () => {
  let pool: Pool;
  const log = createLogger("error", () => {});
  const deps = (model: MatchDeps["model"], extra: Partial<MatchDeps> = {}): MatchDeps => ({ pool, model, log, scoreFacts: facts.scoreFacts, ...extra });

  beforeAll(async () => {
    pool = openPool();
    await migrate(pool);
  });
  afterAll(() => pool.end());
  beforeEach(async () => {
    await resetDatabase(pool);
    await addSource(pool);
  });

  async function crawlJobs(scripts: Script[]) {
    const { connector } = scriptedConnector("greenhouse", scripts);
    for (let index = scripts.length; index > 0; index -= 1) await runCrawl(pool, connector);
  }

  async function prepare(count = 1) {
    const listings = Array.from({ length: count }, (_, index) => rawListing(`job-${index + 1}`));
    await crawlJobs([snapshot(listings)]);
    const profile = await ensureProfile(pool);
    return { profile, summary: await evaluateJobs(pool, config, profile, 1000) };
  }

  const taskRows = async () => (await pool.query(`SELECT * FROM match_tasks ORDER BY id`)).rows;
  const resultRows = async () => (await pool.query(`SELECT * FROM match_results ORDER BY id`)).rows;
  const currentRows = async () => (await pool.query(`SELECT * FROM current_matches ORDER BY id`)).rows;
  const makeDue = () => pool.query(`UPDATE match_tasks SET next_attempt_at = now() WHERE status = 'pending'`);

  describe("evaluation", () => {
    it("records decisions and queues work before any model is involved", async () => {
      await crawlJobs([snapshot([
        rawListing("qa"),
        rawListing("sales", { title: "Account Executive", descriptionText: "Sell things. ".repeat(40) }),
      ])]);
      const profile = await ensureProfile(pool);
      expect(await evaluateJobs(pool, config, profile, 1000)).toMatchObject({ evaluated: 2, eligible: 1, rejected: 1, queued: 1 });

      const { rows } = await pool.query(`SELECT decision, reason_codes, input_key FROM job_evaluations ORDER BY canonical_job_id`);
      expect(rows[0]).toMatchObject({ decision: "eligible", reason_codes: expect.arrayContaining(["title_relevant"]) });
      expect(rows[1]).toEqual({ decision: "rejected", reason_codes: ["title_other_discipline"], input_key: null });
      expect(await taskRows()).toHaveLength(1);
    });

    it("does nothing on a second pass", async () => {
      const { profile } = await prepare(2);
      expect(await evaluateJobs(pool, config, profile, 1000)).toMatchObject({ evaluated: 0, queued: 0 });
      expect(await taskRows()).toHaveLength(2);
    });

    it("does not re-ask about an unchanged job after a full crawl", async () => {
      const listing = rawListing("job-1");
      await crawlJobs([snapshot([listing])]);
      const profile = await ensureProfile(pool);
      await evaluateJobs(pool, config, profile, 1000);
      await runMatch(deps(fakeModel([output()]).model), options());

      const { connector } = scriptedConnector("greenhouse", [snapshot([listing])]);
      await runCrawl(pool, connector, { mode: "full" });
      expect(await evaluateJobs(pool, config, profile, 1000)).toMatchObject({ evaluated: 0, queued: 0 });
      expect(await taskRows()).toHaveLength(1);
    });

    it("requeues a changed job and keeps the old result out of the current view", async () => {
      await crawlJobs([snapshot([rawListing("job-1")])]);
      const profile = await ensureProfile(pool);
      await evaluateJobs(pool, config, profile, 1000);
      await runMatch(deps(fakeModel([output()]).model), options());

      await crawlJobs([snapshot([rawListing("job-1", { descriptionText: "Test automation with Playwright." })])]);
      expect(await evaluateJobs(pool, config, profile, 1000)).toMatchObject({ evaluated: 1, queued: 1 });
      expect(await currentRows()).toHaveLength(0);
      expect(await resultRows()).toHaveLength(1);
    });

    it("re-evaluates on a matching profile change but not on a notification change", async () => {
      const { profile } = await prepare();
      await runMatch(deps(fakeModel([output()]).model), options());

      const notify = await saveProfile(pool, { preferences: { notificationThreshold: 80 } });
      expect(notify.revision).toBe(2);
      expect(notify.matchingHash).toBe(profile.matchingHash);
      expect(await evaluateJobs(pool, config, notify, 1000)).toMatchObject({ evaluated: 0, queued: 0 });
      expect(await currentRows()).toHaveLength(1);

      const changed = await saveProfile(pool, { matching: { ...profile.matching, preferredSkills: ["Cypress"] } });
      expect(await evaluateJobs(pool, config, changed, 1000)).toMatchObject({ evaluated: 1, queued: 1 });
      expect(await currentRows()).toHaveLength(0);
      expect(await resultRows()).toHaveLength(1);
    });

    it("reuses stored answers when only the filter version changed", async () => {
      const { profile } = await prepare();
      await runMatch(deps(fakeModel([output()]).model), options());
      await pool.query(`UPDATE job_evaluations SET filter_version = 'filter-v0'`);
      expect(await evaluateJobs(pool, config, profile, 1000)).toMatchObject({ evaluated: 1, reused: 1, queued: 0 });
      expect(await currentRows()).toHaveLength(1);
    });

    it("supersedes open work when the filter starts rejecting a job", async () => {
      const { profile } = await prepare();
      const strict = await saveProfile(pool, {
        matching: { ...profile.matching, hardRules: { ...profile.matching.hardRules, excludedTitleTerms: ["QA"] } },
      });
      expect(await evaluateJobs(pool, config, strict, 1000)).toMatchObject({ rejected: 1, queued: 0 });
      expect((await taskRows())[0].status).toBe("superseded");
    });

    it("reopens superseded work when a profile returns to an earlier state", async () => {
      const { profile } = await prepare();
      const other = await saveProfile(pool, { matching: { ...profile.matching, preferredSkills: ["Cypress"] } });
      await evaluateJobs(pool, config, other, 1000);
      const back = await saveProfile(pool, { matching: profile.matching });
      await evaluateJobs(pool, config, back, 1000);
      expect((await taskRows()).map((task) => task.status)).toEqual(["pending", "superseded"]);
    });

    it("skips expired jobs and leaves their open work unclaimed", async () => {
      await prepare();
      await pool.query(`UPDATE canonical_jobs SET status = 'expired'`);
      const { model, calls } = fakeModel([]);
      expect(await runMatch(deps(model), options())).toMatchObject({ claimed: 0, stopReason: "queue_empty" });
      expect(calls).toHaveLength(0);
      expect((await taskRows())[0].status).toBe("pending");
    });
  });

  describe("queue limit", () => {
    const LIMIT = 5;
    const JOBS = 50; // ten times the limit
    const open = async () =>
      (await pool.query(`SELECT j.title, t.status, e.priority FROM match_tasks t
                           JOIN job_evaluations e ON e.canonical_job_id = t.canonical_job_id
                           JOIN canonical_jobs j ON j.id = t.canonical_job_id
                          WHERE t.status IN ('pending', 'claimed') ORDER BY e.priority DESC, j.title`)).rows;
    const titleOf = (n: number) => `QA Automation Engineer job-${n}`;

    /** Evaluates with the queue closed, then gives job-N the priority N, so the best-ranked jobs are known. */
    async function seedRanked(count = JOBS) {
      await crawlJobs([snapshot(Array.from({ length: count }, (_, index) => rawListing(`job-${index + 1}`)))]);
      const profile = await ensureProfile(pool);
      expect(await evaluateJobs(pool, config, profile, 0)).toMatchObject({ eligible: count, queued: 0, deferred: count });
      await pool.query(
        `UPDATE job_evaluations e SET priority = substring(j.title from 'job-(\\d+)$')::int
           FROM canonical_jobs j WHERE j.id = e.canonical_job_id`,
      );
      return profile;
    }

    it("queues only the best-ranked jobs, and the model never exceeds the run cap", async () => {
      const profile = await seedRanked();
      expect(await evaluateJobs(pool, config, profile, LIMIT)).toMatchObject({ eligible: 0, queued: LIMIT, deferred: JOBS - LIMIT });
      expect((await open()).map((task) => task.title)).toEqual([50, 49, 48, 47, 46].map(titleOf));

      const first = fakeModel([output(), output(), output(), output()]);
      expect(await runMatch(deps(first.model), options({ maxJobs: 3 }))).toMatchObject({ stopReason: "job_cap", succeeded: 3 });
      expect(first.calls).toHaveLength(3);

      // The queue drains by three and is topped back up with the next-best jobs.
      expect(await evaluateJobs(pool, config, profile, LIMIT)).toMatchObject({ queued: 3, deferred: JOBS - LIMIT - 3 });
      expect((await open()).map((task) => task.priority)).toEqual([47, 46, 45, 44, 43]);

      // Every further run stays inside the cap whatever the number of eligible jobs.
      const second = fakeModel(Array.from({ length: 10 }, () => output()));
      expect(await runMatch(deps(second.model), options({ maxJobs: 3 }))).toMatchObject({ succeeded: 3 });
      expect(second.calls).toHaveLength(3);
      expect(await readBacklog(pool, config)).toMatchObject({ pending: LIMIT - 3 });
    });

    it("gives a closed job's slot to the next-best job instead of holding it forever", async () => {
      const profile = await seedRanked();
      await evaluateJobs(pool, config, profile, LIMIT);
      // job-50 and job-49 close while their tasks are still pending: they can never be claimed.
      await pool.query(
        `UPDATE canonical_jobs SET status = 'expired' WHERE title IN ($1, $2)`,
        [titleOf(50), titleOf(49)],
      );
      expect(await evaluateJobs(pool, config, profile, LIMIT)).toMatchObject({ queued: 2 });
      const runnable = (await open()).filter((task) => task.title !== titleOf(50) && task.title !== titleOf(49));
      expect(runnable.map((task) => task.priority)).toEqual([48, 47, 46, 45, 44]);
    });

    it("lists a deferred job as pending on the dashboard", async () => {
      const profile = await seedRanked();
      await evaluateJobs(pool, config, profile, LIMIT);
      const context = { profile, configHash: hashMatchConfig(config) };
      const deferred = await pool.query(
        `SELECT e.canonical_job_id AS id FROM job_evaluations e
          WHERE NOT EXISTS (SELECT 1 FROM match_tasks t WHERE t.canonical_job_id = e.canonical_job_id) LIMIT 1`,
      );
      expect((await getJob(pool, context, deferred.rows[0].id))?.matchState).toBe("pending");
    });

    it("stops paying for model time once the monthly cap is reached, however many jobs are eligible", async () => {
      const profile = await seedRanked();
      await evaluateJobs(pool, config, profile, LIMIT);
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      await pool.query(`INSERT INTO match_runs (trigger, status, started_at, finished_at) VALUES ('test', 'succeeded', $1, $2)`, [
        new Date(start.getTime() + 60_000).toISOString(),
        new Date(start.getTime() + 31 * 60_000).toISOString(),
      ]);
      const { model, calls } = fakeModel([output()]);
      const affordable = await countAffordable(pool, config, 30);
      expect(affordable).toMatchObject({ pending: 0, runnable: LIMIT });
      // The pending step gates the match stage, so no model is contacted.
      if (affordable.pending > 0) await runMatch(deps(model), options());
      expect(calls).toHaveLength(0);
    });

    it("never re-queues an exhausted task, but reopens a superseded one", async () => {
      const profile = await seedRanked(3);
      await evaluateJobs(pool, config, profile, 3);
      await pool.query(
        `UPDATE match_tasks t SET status = 'exhausted' FROM canonical_jobs j
          WHERE j.id = t.canonical_job_id AND j.title = $1`,
        [titleOf(3)],
      );
      await pool.query(
        `UPDATE match_tasks t SET status = 'superseded' FROM canonical_jobs j
          WHERE j.id = t.canonical_job_id AND j.title = $1`,
        [titleOf(2)],
      );
      expect(await evaluateJobs(pool, config, profile, 10)).toMatchObject({ queued: 1, deferred: 0 });
      const status = async (n: number) =>
        (await pool.query(`SELECT t.status FROM match_tasks t JOIN canonical_jobs j ON j.id = t.canonical_job_id WHERE j.title = $1`, [titleOf(n)])).rows.map((row) => row.status);
      expect(await status(3)).toEqual(["exhausted"]);
      expect(await status(2)).toEqual(["pending"]);
    });

    it("queues nothing with a limit of zero and still shows the jobs as pending", async () => {
      const profile = await seedRanked(3);
      expect(await evaluateJobs(pool, config, profile, 0)).toMatchObject({ queued: 0, deferred: 3 });
      expect(await taskRows()).toHaveLength(0);
      const { rows } = await pool.query(`SELECT canonical_job_id AS id FROM job_evaluations`);
      const context = { profile, configHash: hashMatchConfig(config) };
      for (const row of rows) expect((await getJob(pool, context, row.id))?.matchState).toBe("pending");
    });
  });

  describe("monthly AI budget", () => {
    const addRun = (startedAt: string, finishedAt: string | null) =>
      pool.query(
        `INSERT INTO match_runs (trigger, status, started_at, finished_at) VALUES ('test', 'succeeded', $1, $2)`,
        [startedAt, finishedAt],
      );
    const monthStart = () => {
      const now = new Date();
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    };
    const offsetMinutes = (from: Date, minutes: number) => new Date(from.getTime() + minutes * 60_000).toISOString();

    it("offers the queue while the month has budget left", async () => {
      await prepare(2);
      const start = monthStart();
      await addRun(offsetMinutes(start, 1), offsetMinutes(start, 31));
      expect(await countAffordable(pool, config, 800)).toEqual({ pending: 2, runnable: 2, minutesUsed: 30 });
    });

    it("offers nothing once the cap is reached and keeps the tasks queued", async () => {
      await prepare(2);
      const start = monthStart();
      await addRun(offsetMinutes(start, 1), offsetMinutes(start, 31));
      expect(await countAffordable(pool, config, 30)).toEqual({ pending: 0, runnable: 2, minutesUsed: 30 });
      expect((await taskRows()).map((task) => task.status)).toEqual(["pending", "pending"]);
    });

    it("counts this UTC month only and ignores a run that never finished", async () => {
      await prepare(1);
      const start = monthStart();
      await addRun(offsetMinutes(start, -120), offsetMinutes(start, -60));
      await addRun(offsetMinutes(start, 1), null);
      expect((await countAffordable(pool, config, 800)).minutesUsed).toBe(0);
    });
  });

  describe("inference", () => {
    it("stores a validated result with its provenance and derived score", async () => {
      await prepare();
      const summary = await runMatch(deps(fakeModel([output()]).model), options());
      expect(summary).toMatchObject({ status: "succeeded", stopReason: "queue_empty", claimed: 1, succeeded: 1 });

      const [result] = await resultRows();
      expect(result).toMatchObject({
        score: 80,
        recommendation: "strong_match",
        model_name: config.model,
        model_digest: config.modelDigest,
        prompt_version: config.promptVersion,
        response_schema_version: config.responseSchemaVersion,
        rubric_version: config.rubricVersion,
        model_calls: 1,
        validation_outcome: "valid",
        input_truncated: false,
        evidence_total: 2,
        evidence_literal: 1,
        evidence_unverified: ["invented quote"],
      });
      expect((await taskRows())[0].status).toBe("succeeded");
      expect(await currentRows()).toHaveLength(1);
      const { rows } = await pool.query(`SELECT status, summary FROM match_runs`);
      expect(rows[0]).toMatchObject({ status: "succeeded", summary: { succeeded: 1 } });
    });

    it("retries invalid output once with validation feedback", async () => {
      await prepare();
      const { model, calls } = fakeModel([output({ explanation: "" }), output()]);
      expect(await runMatch(deps(model), options())).toMatchObject({ succeeded: 1, validationRetries: 1 });
      expect(calls).toHaveLength(2);
      expect(calls[1]?.messages.at(-1)?.content).toContain("explanation");
      expect((await resultRows())[0]).toMatchObject({ validation_outcome: "valid_after_retry", model_calls: 2 });
    });

    it("records a failure and backs off, with no result, after the second invalid reply", async () => {
      await prepare();
      const { model, calls } = fakeModel(["nope", "still nope"]);
      expect(await runMatch(deps(model), options())).toMatchObject({ status: "succeeded", succeeded: 0, failed: 1 });
      expect(calls).toHaveLength(2);
      expect(await resultRows()).toHaveLength(0);
      const [task] = await taskRows();
      expect(task).toMatchObject({ status: "pending", attempts: 1, last_error_kind: "invalid_json" });
      expect(task.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 1_700_000);
      expect(await runMatch(deps(fakeModel([]).model), options())).toMatchObject({ claimed: 0 });
    });

    it("stops at the retry ceiling and surfaces the exhausted task until an operator retries it", async () => {
      await prepare();
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await makeDue();
        await runMatch(deps(fakeModel(["bad", "bad"]).model), options());
      }
      expect((await taskRows())[0]).toMatchObject({ status: "exhausted", attempts: 3 });
      expect((await readBacklog(pool, config)).exhausted).toBe(1);
      expect(await runMatch(deps(fakeModel([]).model), options())).toMatchObject({ claimed: 0 });

      expect(await retryFailedTasks(pool)).toBe(1);
      expect(await runMatch(deps(fakeModel([output()]).model), options())).toMatchObject({ succeeded: 1 });
    });

    it("recovers an abandoned claim, and gives up at the ceiling", async () => {
      await prepare();
      const policy = { maxAttempts: 2, retryBaseSeconds: 0 };
      expect(await claimTask(pool, config, "crashed", 60)).not.toBeNull();
      expect(await recoverAbandoned(pool, policy)).toBe(0);

      await pool.query(`UPDATE match_tasks SET lease_until = now() - interval '1 second'`);
      expect(await recoverAbandoned(pool, policy)).toBe(1);
      expect((await taskRows())[0]).toMatchObject({ status: "pending", attempts: 1, last_error_kind: "abandoned", lease_owner: null });

      await claimTask(pool, config, "crashed", 60);
      await pool.query(`UPDATE match_tasks SET lease_until = now() - interval '1 second'`);
      await recoverAbandoned(pool, policy);
      expect((await taskRows())[0]).toMatchObject({ status: "exhausted", attempts: 2 });
    });

    it("claims the most recently posted job first within a priority", async () => {
      const posted = (date: string) => ({ publishedAt: new Date(date) });
      await crawlJobs([
        snapshot([
          rawListing("older", posted("2026-01-01")),
          rawListing("undated"),
          rawListing("newer", posted("2026-10-01")),
          rawListing("low", { ...posted("2026-10-30"), title: "Software Engineer", descriptionText: `${"Build things for people. ".repeat(12)} Playwright.` }),
        ]),
      ]);
      await evaluateJobs(pool, config, await ensureProfile(pool), 1000);
      const order: string[] = [];
      for (;;) {
        const task = await claimTask(pool, config, "a", 60);
        if (!task) break;
        order.push(task.job.title);
      }
      expect(order).toEqual([
        "QA Automation Engineer newer",
        "QA Automation Engineer older",
        "QA Automation Engineer undated",
        "Software Engineer",
      ]);
    });

    it("hands one task to only one worker", async () => {
      await prepare();
      const claims = await Promise.all([claimTask(pool, config, "a", 60), claimTask(pool, config, "b", 60)]);
      expect(claims.filter(Boolean)).toHaveLength(1);
    });

    it("stops without spending attempts when the model cannot be reached", async () => {
      await prepare();
      const before = fakeModel([], new OllamaError("unavailable", "connection refused"));
      expect(await runMatch(deps(before.model), options())).toMatchObject({ status: "failed", stopReason: "model_unavailable" });
      expect(before.calls).toHaveLength(0);
      expect((await taskRows())[0]).toMatchObject({ status: "pending", attempts: 0 });

      const during = fakeModel([new OllamaError("unavailable", "connection reset")]);
      expect(await runMatch(deps(during.model), options())).toMatchObject({ status: "failed", stopReason: "model_unavailable", claimed: 1 });
      expect((await taskRows())[0]).toMatchObject({ status: "pending", attempts: 0, last_error_kind: "unavailable" });
    });

    it("counts a server error against the job and stops the stage", async () => {
      await prepare(2);
      const { model, calls } = fakeModel([new OllamaError("http", "500")]);
      expect(await runMatch(deps(model), options())).toMatchObject({ status: "failed", stopReason: "model_error", failed: 1 });
      expect(calls).toHaveLength(1);
      expect((await taskRows()).map((task) => task.attempts).sort()).toEqual([0, 1]);
    });

    it("counts a timeout as an attempt and moves on to the next job", async () => {
      await prepare(2);
      const { model } = fakeModel([new OllamaError("timeout", "too slow"), output()]);
      expect(await runMatch(deps(model), options())).toMatchObject({ failed: 1, succeeded: 1, stopReason: "queue_empty" });
      expect((await taskRows()).map((task) => task.last_error_kind).sort()).toEqual([null, "timeout"].sort());
    });

    it("refuses to run a model whose digest differs from the lock", async () => {
      await prepare();
      const { model, calls } = fakeModel([], "sha-of-something-else");
      expect(await runMatch(deps(model), options())).toMatchObject({ status: "failed", stopReason: "digest_mismatch" });
      expect(calls).toHaveLength(0);
      expect((await taskRows())[0]).toMatchObject({ status: "pending", attempts: 0 });
    });

    it("does not contact the model when no work is due", async () => {
      await prepare(0);
      const { model } = fakeModel([], new OllamaError("unavailable", "not started"));
      expect(await runMatch(deps(model), options())).toMatchObject({ status: "succeeded", stopReason: "queue_empty" });
    });

    it("keeps a result as history when the profile changes during inference", async () => {
      const { profile } = await prepare();
      const { model } = fakeModel([async () => {
        const changed = await saveProfile(pool, { matching: { ...profile.matching, preferredSkills: ["Cypress"] } });
        await evaluateJobs(pool, config, changed, 1000);
        return output();
      }]);
      expect(await runMatch(deps(model), options({ maxJobs: 1 }))).toMatchObject({ succeeded: 0, superseded: 1 });
      expect(await resultRows()).toHaveLength(1);
      expect(await currentRows()).toHaveLength(0);
      expect((await taskRows()).map((task) => task.status)).toEqual(["superseded", "pending"]);
    });

    it("does not claim a task for a profile that is no longer current", async () => {
      const { profile } = await prepare();
      await saveProfile(pool, { matching: { ...profile.matching, preferredSkills: ["Cypress"] } });
      expect(await runMatch(deps(fakeModel([]).model), options())).toMatchObject({ claimed: 0 });
    });

    it("stops at the job cap and reports the backlog", async () => {
      await prepare(3);
      const { model } = fakeModel([output(), output()]);
      const summary = await runMatch(deps(model), options({ maxJobs: 2 }));
      expect(summary).toMatchObject({ stopReason: "job_cap", status: "succeeded", succeeded: 2 });
      expect(summary.backlog).toMatchObject({ pending: 1, due: 1, exhausted: 0 });
      expect(summary.backlog.oldestAgeSeconds).toBeGreaterThanOrEqual(0);
    });

    it("starts no job the time budget cannot finish", async () => {
      await prepare(3);
      let clock = 0;
      const { model } = fakeModel([() => {
        clock += 300_000;
        return output();
      }, () => {
        clock += 300_000;
        return output();
      }]);
      const summary = await runMatch(deps(model, { now: () => clock }), options({ timeBudgetSeconds: 600 }));
      // After 300 s a 180 s call still fits; after 600 s it does not.
      expect(summary).toMatchObject({ stopReason: "time_budget", claimed: 2, succeeded: 2 });
      expect(summary.backlog.pending).toBe(1);
    });

    it("skips the validation retry when no budget remains for it", async () => {
      await prepare();
      let clock = 0;
      const { model, calls } = fakeModel([() => {
        clock += 300_000;
        return "bad";
      }]);
      expect(await runMatch(deps(model, { now: () => clock }), options({ timeBudgetSeconds: 400 }))).toMatchObject({ failed: 1 });
      expect(calls).toHaveLength(1);
    });

    it("works on the most relevant job first", async () => {
      await crawlJobs([snapshot([
        rawListing("low", { title: "Software Engineer", descriptionText: `Build our test automation. ${"Team detail. ".repeat(30)}` }),
        rawListing("high", { title: "QA Automation Engineer" }),
      ])]);
      await evaluateJobs(pool, config, await ensureProfile(pool), 1000);
      const task = await claimTask(pool, config, "a", 60);
      expect(task?.job.title).toBe("QA Automation Engineer");
    });

    it("re-asks on an explicit force and replaces the stored answer", async () => {
      await prepare();
      await runMatch(deps(fakeModel([output()]).model), options());
      expect(await forceRematch(pool)).toBe(1);
      const { model, calls } = fakeModel([output({ role_category: "manual_qa", points: { skills: 5 } })]);
      await runMatch(deps(model), options());
      expect(calls).toHaveLength(1);
      const results = await resultRows();
      expect(results).toHaveLength(1);
      expect(results[0].score).toBe(37); // manual QA 12, pinned skills 5, other pinned facts 20
    });

    it("does not run tasks built for another configuration", async () => {
      await prepare();
      const other = buildMatchConfig({ OLLAMA_NUM_CTX: 3072, MAX_OUTPUT_TOKENS: 700, MAX_JOB_INPUT_TOKENS: 1600 });
      expect(hashMatchConfig(other)).not.toBe(hashMatchConfig(config));
      expect(await runMatch(deps(fakeModel([]).model), options({ config: other }))).toMatchObject({ claimed: 0 });
    });
  });
});
