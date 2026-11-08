import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate";
import type { Pool } from "../../src/db/pool";
import { createLogger } from "../../src/logger";
import { buildMatchConfig } from "../../src/match/config";
import type { ChatResult } from "../../src/match/ollama-client";
import { evaluateJobs } from "../../src/match/queue";
import { runMatch } from "../../src/match/runner";
import { buildRelevance } from "../../src/notify/outbox";
import { runNotify } from "../../src/notify/sender";
import type { MessageSender } from "../../src/notify/telegram";
import { DEFAULT_ADJACENT_TITLES } from "../../src/profile/schema";
import { ensureProfile, saveProfile } from "../../src/profile/store";
import { scriptedFacts } from "../scripted-facts";
import { addSource, openPool, rawListing, resetDatabase, runCrawl, scriptedConnector, snapshot } from "./helpers";

const config = buildMatchConfig({ OLLAMA_NUM_CTX: 3072, MAX_OUTPUT_TOKENS: 800, MAX_JOB_INPUT_TOKENS: 1600 });
const facts = scriptedFacts();
const log = createLogger("error", () => {});

const reply = JSON.stringify({
  role_category: "qa_automation",
  matching_requirements: [{ requirement: "Automation", evidence: "Test automation" }],
  missing_requirements: [],
  unknown_requirements: [],
  concerns: [],
  explanation: "A good fit.",
  points: { role: 40, skills: 25, experience: 8, location: 5, industry: 2 },
});

const model = {
  async modelDigest() {
    return config.modelDigest;
  },
  async chat(): Promise<ChatResult> {
    facts.observe(reply);
    return { content: reply, doneReason: "stop", totalMs: 1, loadMs: 0, promptTokens: 1, promptMs: 0, outputTokens: 1, outputMs: 0 };
  },
};

const LONG = "We keep our cloud platform running and reliable for every customer, around the clock. ".repeat(4);
const OFFICE = rawListing("office", { title: "Office Manager", descriptionText: "Run the office." });
const NEW_JOBS = [
  rawListing("qa-a"),
  rawListing("devops", { title: "DevOps Engineer", descriptionText: LONG }),
  rawListing("support", { title: "Technical Support Engineer", descriptionText: LONG }),
  rawListing("sre", { title: "Site Reliability Engineer", descriptionText: LONG }),
];

describe("adjacent tier", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = openPool();
    await migrate(pool);
  });
  afterAll(() => pool.end());

  /** One full pipeline pass: baseline, then new jobs, through evaluate, match and notify. */
  async function runPipeline(adjacentTitles: string[]) {
    await resetDatabase(pool);
    await addSource(pool);
    const initial = await ensureProfile(pool);
    await saveProfile(pool, { preferences: { ...initial.preferences, adjacentTitles } });
    const sent: string[] = [];
    const sender: MessageSender = {
      async send(html) {
        sent.push(html);
        return { kind: "sent", messageId: String(sent.length) };
      },
    };
    for (const listings of [[OFFICE], [OFFICE, ...NEW_JOBS]]) {
      const { connector } = scriptedConnector("greenhouse", [snapshot(listings)]);
      await runCrawl(pool, connector);
      const profile = await ensureProfile(pool);
      await evaluateJobs(pool, config, profile);
      await runMatch(
        { pool, model, log, scoreFacts: facts.scoreFacts },
        { trigger: "test", config, maxJobs: 50, timeBudgetSeconds: 600, inferenceTimeoutSeconds: 180, maxAttempts: 3, retryBaseSeconds: 0 },
      );
      await runNotify(
        { pool, sender, log, sleep: async () => {} },
        {
          trigger: "test",
          relevance: buildRelevance(profile, config),
          dryRun: false,
          maxAlerts: 10,
          maxDigests: 2,
          digestSize: 5,
          maxAttempts: 3,
          retryBaseSeconds: 60,
          timeBudgetSeconds: 60,
        },
      );
    }
    const profile = await ensureProfile(pool);
    const { rows: evaluations } = await pool.query(
      `SELECT c.title, e.decision, e.reason_codes, e.filter_version, e.profile_hash, e.input_key
         FROM job_evaluations e JOIN canonical_jobs c ON c.id = e.canonical_job_id ORDER BY c.title`,
    );
    const { rows: tasks } = await pool.query(
      `SELECT c.title, t.status, t.input_key, t.priority
         FROM match_tasks t JOIN canonical_jobs c ON c.id = t.canonical_job_id ORDER BY c.title`,
    );
    const { rows: notifications } = await pool.query(`SELECT kind, status FROM notifications ORDER BY id`);
    return { evaluations, tasks, notifications, sent, matchingHash: profile.matchingHash };
  }

  it("changes nothing the model or Telegram sees when the adjacent terms change", async () => {
    const without = await runPipeline([]);
    const withDefaults = await runPipeline(DEFAULT_ADJACENT_TITLES);

    expect(without.matchingHash).toBe(withDefaults.matchingHash);
    expect(withDefaults.evaluations).toEqual(without.evaluations);
    expect(withDefaults.tasks).toEqual(without.tasks);
    expect(withDefaults.notifications).toEqual(without.notifications);
    expect(withDefaults.sent).toEqual(without.sent);

    // The scenario is real: the adjacent jobs were rejected and never queued, and one strict job alerted.
    const decisions = Object.fromEntries(without.evaluations.map((row) => [row.title, row.decision]));
    expect(decisions).toMatchObject({ "DevOps Engineer": "rejected", "Technical Support Engineer": "rejected", "Site Reliability Engineer": "rejected" });
    expect(without.tasks.map((row) => row.title)).not.toContain("DevOps Engineer");
    expect(without.sent.length).toBeGreaterThan(0);
  });
});
