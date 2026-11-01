import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate";
import { withTransaction, type Pool } from "../../src/db/pool";
import { createLogger } from "../../src/logger";
import { buildMatchConfig } from "../../src/match/config";
import type { ChatResult } from "../../src/match/ollama-client";
import { evaluateJobs, forceRematch } from "../../src/match/queue";
import { runMatch, type MatchDeps } from "../../src/match/runner";
import {
  buildRelevance,
  claimNotification,
  markAmbiguous,
  markSending,
  markSent,
  planNotifications,
  recoverNotificationClaims,
  startEpoch,
  type Relevance,
} from "../../src/notify/outbox";
import { runNotify, type NotifyOptions } from "../../src/notify/sender";
import type { MessageSender, SendOutcome } from "../../src/notify/telegram";
import { ensureProfile, saveProfile } from "../../src/profile/store";
import { cleanup, readHealth, renderHealth } from "../../src/worker/maintenance";
import { addSource, openPool, rawListing, resetDatabase, runCrawl, scriptedConnector, snapshot, type Script } from "./helpers";

const config = buildMatchConfig({ OLLAMA_NUM_CTX: 3072, MAX_OUTPUT_TOKENS: 800, MAX_JOB_INPUT_TOKENS: 1600 });

const modelReply = (skills = 25) =>
  JSON.stringify({
    role_category: "qa_automation",
    matching_requirements: [{ requirement: "Automation", evidence: "Test automation" }],
    missing_requirements: [
      { requirement: "Rust", evidence: "Test automation", candidate_fact: null },
      { requirement: "Go", evidence: "invented quote", candidate_fact: null },
    ],
    unknown_requirements: [],
    concerns: [],
    explanation: "A good fit.",
    points: { role: 40, skills, experience: 8, location: 5, industry: 2 },
  });

const HIGH = 25; // Adds up to 80.
const LOW = 5; // Adds up to 60.

function fakeModel(replies: string[] | (() => string)): MatchDeps["model"] {
  return {
    async modelDigest() {
      return config.modelDigest;
    },
    async chat(): Promise<ChatResult> {
      const content = typeof replies === "function" ? replies() : replies.shift();
      if (content === undefined) throw new Error("Model script exhausted");
      return { content, doneReason: "stop", totalMs: 1, loadMs: 0, promptTokens: 1, promptMs: 0, outputTokens: 1, outputMs: 0 };
    },
  };
}

function fakeSender(outcomes: Array<SendOutcome | ((html: string) => SendOutcome)> = []) {
  const sent: string[] = [];
  let nextId = 100;
  const sender: MessageSender = {
    async send(html) {
      const next = outcomes.shift();
      const outcome = typeof next === "function" ? next(html) : next;
      if (outcome && outcome.kind !== "sent") return outcome;
      sent.push(html);
      nextId += 1;
      return outcome ?? { kind: "sent", messageId: String(nextId) };
    },
  };
  return { sender, sent };
}

describe("notifications", () => {
  let pool: Pool;
  const log = createLogger("error", () => {});
  const noSleep = async (_ms: number) => {};

  beforeAll(async () => {
    pool = openPool();
    await migrate(pool);
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    await addSource(pool);
  });
  afterAll(() => pool.end());

  const relevance = async (): Promise<Relevance> => buildRelevance(await ensureProfile(pool), config);

  async function notifyOptions(overrides: Partial<NotifyOptions> = {}): Promise<NotifyOptions> {
    return {
      trigger: "test",
      relevance: await relevance(),
      dryRun: false,
      maxAlerts: 10,
      maxDigests: 2,
      digestSize: 5,
      maxAttempts: 3,
      retryBaseSeconds: 60,
      timeBudgetSeconds: 60,
      ...overrides,
    };
  }

  const notify = async (sender: MessageSender | null, overrides: Partial<NotifyOptions> = {}, sleep = noSleep) =>
    runNotify({ pool, sender, log, sleep }, await notifyOptions(overrides));

  async function crawlOnce(script: Script) {
    const { connector } = scriptedConnector("greenhouse", [script]);
    await runCrawl(pool, connector);
  }

  async function evaluate() {
    await evaluateJobs(pool, config, await ensureProfile(pool));
  }

  async function match(replies: string[] | (() => string) = () => modelReply(HIGH), maxJobs = 50) {
    await evaluate();
    return runMatch(
      { pool, model: fakeModel(replies), log },
      { trigger: "test", config, maxJobs, timeBudgetSeconds: 600, inferenceTimeoutSeconds: 180, maxAttempts: 3, retryBaseSeconds: 0 },
    );
  }

  const OFFICE_JOB = rawListing("office", { title: "Office Manager", descriptionText: "Run the office.", originalDescription: "<p>Run the office.</p>" });

  /** A source whose baseline holds nothing relevant, so later jobs count as new. */
  async function establishBaseline() {
    await crawlOnce(snapshot([OFFICE_JOB]));
    await match();
  }

  async function discover(...ids: string[]) {
    await crawlOnce(snapshot([OFFICE_JOB, ...ids.map((id) => rawListing(id))]));
  }

  const rows = async () => (await pool.query(`SELECT * FROM notifications ORDER BY id`)).rows;
  const statuses = async () => (await rows()).map((row) => row.status);
  const dueNow = () => pool.query(`UPDATE notifications SET next_attempt_at = now() WHERE status IN ('pending', 'retry')`);

  describe("baselines", () => {
    it("sends one capped digest instead of an alert per historic listing", async () => {
      await crawlOnce(snapshot(["a", "b", "c", "d", "e", "f", "g"].map((id) => rawListing(id))));
      await match();
      const { sender, sent } = fakeSender();
      const summary = await notify(sender);

      expect(summary).toMatchObject({ status: "succeeded", alerts: 0, digests: 1, sent: 1 });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("2 more on the dashboard");
      expect(sent[0]!.match(/80\/100/g)).toHaveLength(5);
      const [row] = await rows();
      expect(row).toMatchObject({ kind: "digest", status: "sent", more_count: 2 });
      expect(row.job_ids).toHaveLength(5);
    });

    it("waits until every baseline job has a verdict", async () => {
      await crawlOnce(snapshot([rawListing("a"), rawListing("b")]));
      await match(() => modelReply(HIGH), 1);
      expect((await notify(fakeSender().sender)).digests).toBe(0);
      await match();
      expect((await notify(fakeSender().sender)).digests).toBe(1);
    });

    it("records a baseline with no matches so a later rematch cannot raise a digest", async () => {
      await crawlOnce(snapshot([rawListing("a")]));
      await match(() => modelReply(LOW));
      await notify(fakeSender().sender);
      expect(await rows()).toMatchObject([{ status: "suppressed", suppressed_reason: "no_qualifying_jobs" }]);

      await forceRematch(pool);
      await match(() => modelReply(HIGH));
      const { sender, sent } = fakeSender();
      await notify(sender);
      expect(sent).toHaveLength(0);
    });
  });

  describe("event identity", () => {
    it("alerts once for a new job and stores the Telegram message id", async () => {
      await establishBaseline();
      await discover("a");
      await match();
      const first = fakeSender();
      expect(await notify(first.sender)).toMatchObject({ alerts: 1, sent: 1 });
      expect(first.sent[0]).toContain("New match");

      const second = fakeSender();
      expect(await notify(second.sender)).toMatchObject({ alerts: 0, sent: 0 });
      expect(second.sent).toHaveLength(0);
      const alert = (await rows()).find((row) => row.kind === "alert");
      expect(alert).toMatchObject({ status: "sent", message_id: "101" });
      expect(alert.sent_input_key).toEqual(expect.any(String));
    });

    it("plans nothing twice when replayed concurrently", async () => {
      await establishBaseline();
      await discover("a", "b");
      await match();
      const replay = async () => withTransaction(pool, async (client) => planNotifications(client, await relevance(), 5));
      await Promise.all([replay(), replay(), replay()]);
      expect((await rows()).filter((row) => row.kind === "alert")).toHaveLength(2);
    });

    it("lets the database refuse a duplicate identity", async () => {
      await establishBaseline();
      await discover("a");
      await match();
      await notify(null);
      const copy = `INSERT INTO notifications (profile_id, channel, kind, event_key, canonical_job_id, job_event_id)
                    SELECT profile_id, channel, kind, event_key, canonical_job_id, job_event_id FROM notifications WHERE kind = 'alert'`;
      await expect(pool.query(copy)).rejects.toThrow(/unique/i);
    });

    it("gives every reopening cycle its own alert although the content is identical", async () => {
      await establishBaseline();
      await discover("a");
      await match();
      await notify(fakeSender().sender);

      for (let cycle = 0; cycle < 2; cycle += 1) {
        await crawlOnce(snapshot([OFFICE_JOB]));
        await crawlOnce(snapshot([OFFICE_JOB]));
        await crawlOnce(snapshot([OFFICE_JOB]));
        await discover("a");
        await match();
        const { sender, sent } = fakeSender();
        await notify(sender);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toContain("reopened");
      }
      const keys = (await rows()).filter((row) => row.kind === "alert").map((row) => row.event_key);
      expect(new Set(keys).size).toBe(3);
    });

    it("alerts on a significant change and stays quiet on any other", async () => {
      await establishBaseline();
      await discover("a");
      await match();
      await notify(fakeSender().sender);

      const quiet = rawListing("a", { descriptionText: "Test automation for team a. Lunch is provided.", originalDescription: "<p>Lunch</p>" });
      await crawlOnce(snapshot([OFFICE_JOB, quiet]));
      await match();
      const first = fakeSender();
      await notify(first.sender);
      expect(first.sent).toHaveLength(0);

      const moved = rawListing("a", { location: "Haifa, Israel" });
      await crawlOnce(snapshot([OFFICE_JOB, moved]));
      await match();
      const second = fakeSender();
      await notify(second.sender);
      expect(second.sent).toHaveLength(1);
      expect(second.sent[0]).toContain("changed");
    });

    it("sends one message for a job that changed before its first verdict", async () => {
      await establishBaseline();
      await discover("a");
      await crawlOnce(snapshot([OFFICE_JOB, rawListing("a", { location: "Haifa, Israel" })]));
      await crawlOnce(snapshot([OFFICE_JOB, rawListing("a", { location: "Beer Sheva, Israel" })]));
      await match();
      const { sender, sent } = fakeSender();
      await notify(sender);
      expect(sent).toHaveLength(1);
    });

    it("replaces a queued alert when a newer event arrives", async () => {
      await establishBaseline();
      await discover("a");
      await match();
      await notify(null);
      await crawlOnce(snapshot([OFFICE_JOB, rawListing("a", { location: "Haifa, Israel" })]));
      await match();
      const { sender, sent } = fakeSender();
      await notify(sender);
      expect(sent).toHaveLength(1);
      const alerts = (await rows()).filter((row) => row.kind === "alert");
      expect(alerts).toMatchObject([
        { status: "suppressed", suppressed_reason: "superseded_by_newer_event" },
        { status: "sent" },
      ]);
    });

    it("does not alert below the threshold", async () => {
      await establishBaseline();
      await discover("a");
      await match(() => modelReply(LOW));
      expect(await notify(fakeSender().sender)).toMatchObject({ alerts: 0, sent: 0 });
    });
  });

  describe("relevance changes", () => {
    /** Two old jobs below the threshold that the next model answer lifts above it. */
    async function oldJobsThatLaterQualify() {
      await establishBaseline();
      await discover("a", "b", "c");
      await match(() => modelReply(LOW));
      await notify(fakeSender().sender);
    }

    async function changeProfile() {
      const { matching } = await ensureProfile(pool);
      await saveProfile(pool, { matching: { ...matching, preferredIndustries: [...matching.preferredIndustries, "Logistics"] } });
    }

    it("does not flood the channel after a profile change", async () => {
      await oldJobsThatLaterQualify();
      await notify(fakeSender().sender);
      await changeProfile();
      await notify(fakeSender().sender); // Records the new epoch before the rematch finishes.
      await match(() => modelReply(HIGH));
      const { sender, sent } = fakeSender();
      expect(await notify(sender)).toMatchObject({ alerts: 0, sent: 0 });
      expect(sent).toHaveLength(0);
    });

    it("does not flood the channel even when the rematch finishes before any notify run", async () => {
      await oldJobsThatLaterQualify();
      await changeProfile();
      await match(() => modelReply(HIGH));
      const { sender, sent } = fakeSender();
      await notify(sender);
      expect(sent).toHaveLength(0);
    });

    it("still alerts on a job discovered after the profile changed", async () => {
      await oldJobsThatLaterQualify();
      await changeProfile();
      await match(() => modelReply(LOW));
      await notify(fakeSender().sender);
      await discover("a", "b", "c", "d");
      await match(() => modelReply(HIGH));
      const { sender, sent } = fakeSender();
      await notify(sender);
      expect(sent).toHaveLength(1);
    });

    it("offers old jobs as a capped opt-in digest, once per epoch", async () => {
      await oldJobsThatLaterQualify();
      await changeProfile();
      await match(() => modelReply(HIGH));
      await notify(fakeSender().sender);

      const first = fakeSender();
      expect(await notify(first.sender, { rematchDigest: true, digestSize: 2 })).toMatchObject({ digests: 1, sent: 1 });
      expect(first.sent[0]).toContain("Older jobs that now match");
      expect(first.sent[0]).toContain("1 more on the dashboard");

      const second = fakeSender();
      await notify(second.sender, { rematchDigest: true, digestSize: 2 });
      expect(second.sent).toHaveLength(0);
    });

    it("does not alert when the threshold is lowered", async () => {
      await oldJobsThatLaterQualify();
      await saveProfile(pool, { preferences: { notificationThreshold: 50 } });
      const { sender, sent } = fakeSender();
      await notify(sender);
      expect(sent).toHaveLength(0);
    });

    it("does not alert after a forced rematch that happens to raise scores", async () => {
      await oldJobsThatLaterQualify();
      await startEpoch(pool, await relevance(), "force_rematch");
      await forceRematch(pool);
      await match(() => modelReply(HIGH));
      const { sender, sent } = fakeSender();
      await notify(sender);
      expect(sent).toHaveLength(0);
    });
  });

  describe("rechecking a delayed event", () => {
    async function queuedAlert() {
      await establishBaseline();
      await discover("a");
      await match();
      await notify(null);
      expect(await statuses()).toContain("pending");
    }

    const alertRow = async () => (await rows()).find((row) => row.kind === "alert");

    it("suppresses a job that expired while queued", async () => {
      await queuedAlert();
      for (let crawl = 0; crawl < 3; crawl += 1) await crawlOnce(snapshot([OFFICE_JOB]));
      const { sender, sent } = fakeSender();
      expect(await notify(sender)).toMatchObject({ suppressed: 1, sent: 0 });
      expect(sent).toHaveLength(0);
      expect(await alertRow()).toMatchObject({ status: "suppressed", suppressed_reason: "job_inactive" });
    });

    it("suppresses a job below a raised threshold", async () => {
      await queuedAlert();
      await saveProfile(pool, { preferences: { notificationThreshold: 95 } });
      await notify(fakeSender().sender);
      expect(await alertRow()).toMatchObject({ status: "suppressed", suppressed_reason: "below_threshold" });
    });

    it("suppresses a job the filter now rejects", async () => {
      await queuedAlert();
      const { matching } = await ensureProfile(pool);
      await saveProfile(pool, { matching: { ...matching, hardRules: { ...matching.hardRules, excludedTitleTerms: ["Engineer"] } } });
      await evaluate();
      await notify(fakeSender().sender);
      expect(await alertRow()).toMatchObject({ status: "suppressed", suppressed_reason: "no_current_match" });
    });

    it("waits while the job's new content has no verdict yet, then sends it", async () => {
      await queuedAlert();
      const insignificant = rawListing("a", { descriptionText: "Test automation for team a. Lunch is provided.", originalDescription: "<p>Lunch</p>" });
      await crawlOnce(snapshot([OFFICE_JOB, insignificant]));
      const waiting = fakeSender();
      expect(await notify(waiting.sender)).toMatchObject({ deferred: 1, sent: 0 });
      expect(await alertRow()).toMatchObject({ status: "pending", attempts: 0 });

      await match();
      await dueNow();
      const { sender, sent } = fakeSender();
      await notify(sender);
      expect(sent).toHaveLength(1);
    });

    it("sends the current verdict rather than the one it was queued with", async () => {
      await queuedAlert();
      await saveProfile(pool, { preferences: { notificationThreshold: 75 } });
      const { sender, sent } = fakeSender();
      await notify(sender);
      expect(sent[0]).toContain("80/100");
    });

    it("drops expired jobs from a digest and keeps the rest", async () => {
      await crawlOnce(snapshot([rawListing("a"), rawListing("b"), rawListing("c"), rawListing("d")]));
      await match();
      await notify(null);
      for (let crawl = 0; crawl < 3; crawl += 1) await crawlOnce(snapshot([rawListing("a"), rawListing("b"), rawListing("c")]));
      const { sender, sent } = fakeSender();
      await notify(sender);
      expect(sent[0]!.match(/80\/100/g)).toHaveLength(3);
      expect((await rows())[0].job_ids).toHaveLength(3);
    });
  });

  describe("delivery limits", () => {
    it("keeps events beyond the per-run cap pending and sends the best first", async () => {
      await establishBaseline();
      await discover("a", "b", "c", "d");
      const scores = [LOW + 15, HIGH, LOW + 15, HIGH + 2];
      await match(() => modelReply(scores.shift()!));
      const first = fakeSender();
      expect(await notify(first.sender, { maxAlerts: 2 })).toMatchObject({ sent: 2 });
      expect(first.sent[0]).toContain("82/100");
      expect(first.sent[1]).toContain("80/100");
      expect((await rows()).filter((row) => row.status === "pending")).toHaveLength(2);

      const second = fakeSender();
      expect(await notify(second.sender, { maxAlerts: 2 })).toMatchObject({ alerts: 0, sent: 2 });
    });

    it("keeps digests beyond the per-run cap pending", async () => {
      await addSource(pool, "Second Co", "second");
      const { connector } = scriptedConnector("greenhouse", [snapshot([rawListing("a")]), snapshot([rawListing("b")])]);
      await runCrawl(pool, connector);
      await match();
      const first = fakeSender();
      await notify(first.sender, { maxDigests: 1 });
      expect(first.sent).toHaveLength(1);
      expect(await statuses()).toEqual(expect.arrayContaining(["sent", "pending"]));
    });

    it("spaces messages at least a second apart", async () => {
      await establishBaseline();
      await discover("a", "b", "c");
      await match();
      const waits: number[] = [];
      await notify(fakeSender().sender, {}, async () => {});
      expect(waits).toHaveLength(0);

      await discover("a", "b", "c", "d", "e");
      await match();
      await notify(fakeSender().sender, {}, async (ms: number) => {
        waits.push(ms);
      });
      expect(waits).toHaveLength(1);
      expect(waits[0]).toBeGreaterThan(900);
    });

    it("stops at the time budget and leaves the rest pending", async () => {
      await establishBaseline();
      await discover("a", "b");
      await match();
      const options = await notifyOptions();
      const summary = await runNotify({ pool, sender: fakeSender().sender, log, sleep: noSleep }, { ...options, timeBudgetSeconds: 0 });
      expect(summary).toMatchObject({ stopReason: "time_budget", sent: 0 });
      expect((await rows()).filter((row) => row.status === "pending")).toHaveLength(2);
    });

    it("honors a long flood wait and stops the run", async () => {
      await establishBaseline();
      await discover("a", "b");
      await match();
      const { sender } = fakeSender([{ kind: "rate_limited", retryAfterSeconds: 3600, detail: "HTTP 429" }]);
      const summary = await notify(sender);
      expect(summary).toMatchObject({ stopReason: "rate_limited", status: "partial", sent: 0 });
      const [limited] = (await rows()).filter((row) => row.status === "retry");
      expect(limited.attempts).toBe(0);
      expect(limited.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    });

    it("waits out a short flood wait and carries on", async () => {
      await establishBaseline();
      await discover("a", "b");
      await match();
      const waits: number[] = [];
      const { sender, sent } = fakeSender([{ kind: "rate_limited", retryAfterSeconds: 5, detail: "HTTP 429" }]);
      await notify(sender, {}, async (ms: number) => {
        waits.push(ms);
      });
      expect(waits).toContain(5000);
      expect(sent).toHaveLength(1);
    });
  });

  describe("delivery failures", () => {
    async function oneAlert() {
      await establishBaseline();
      await discover("a");
      await match();
    }

    const alertRow = async () => (await rows()).find((row) => row.kind === "alert");

    it("retries a send that never reached Telegram, within a bound", async () => {
      await oneAlert();
      const down = { kind: "not_delivered", detail: "ENOTFOUND" } as const;
      for (const attempts of [1, 2]) {
        expect(await notify(fakeSender([down]).sender)).toMatchObject({ status: "partial", stopReason: "telegram_unavailable" });
        expect(await alertRow()).toMatchObject({ status: "retry", attempts });
        await dueNow();
      }
      await notify(fakeSender([down]).sender);
      expect(await alertRow()).toMatchObject({ status: "failed", attempts: 3 });
      const { sender, sent } = fakeSender();
      await notify(sender);
      expect(sent).toHaveLength(0);
    });

    it("backs off exponentially", async () => {
      await oneAlert();
      await notify(fakeSender([{ kind: "not_delivered", detail: "x" }]).sender);
      await dueNow();
      await notify(fakeSender([{ kind: "not_delivered", detail: "x" }]).sender);
      const remaining = (await alertRow()).next_attempt_at.getTime() - Date.now();
      expect(remaining).toBeGreaterThan(100_000);
      expect(remaining).toBeLessThanOrEqual(120_000);
    });

    it("marks a lost acknowledgement ambiguous and never resends it alone", async () => {
      await oneAlert();
      await notify(fakeSender([{ kind: "ambiguous", detail: "ECONNRESET" }]).sender);
      expect(await alertRow()).toMatchObject({ status: "ambiguous", last_error_kind: "ambiguous" });

      await dueNow();
      const { sender, sent } = fakeSender();
      await notify(sender);
      expect(sent).toHaveLength(0);
    });

    it("resends an ambiguous message only when the operator asks", async () => {
      await oneAlert();
      await notify(fakeSender([{ kind: "ambiguous", detail: "ECONNRESET" }]).sender);
      const { sender, sent } = fakeSender();
      expect(await notify(sender, { reopen: ["ambiguous"] })).toMatchObject({ reopened: 1, sent: 1 });
      expect(sent).toHaveLength(1);
      expect(await alertRow()).toMatchObject({ status: "sent" });
    });

    it("returns a lapsed claim that never began sending to the queue", async () => {
      await oneAlert();
      await notify(null);
      const { profileId } = await relevance();
      await claimNotification(pool, profileId, "alert", "dead-worker", 60);
      await pool.query(`UPDATE notifications SET lease_until = now() - interval '1 second' WHERE status = 'claimed'`);
      expect(await recoverNotificationClaims(pool)).toEqual({ released: 1, ambiguous: 0 });
      expect(await alertRow()).toMatchObject({ status: "pending" });
    });

    it("makes a lapsed claim ambiguous once sending began", async () => {
      await oneAlert();
      await notify(null);
      const { profileId } = await relevance();
      const claimed = await claimNotification(pool, profileId, "alert", "dead-worker", 60);
      expect(await markSending(pool, claimed!.id, "dead-worker")).toBe(true);
      await pool.query(`UPDATE notifications SET lease_until = now() - interval '1 second' WHERE status = 'claimed'`);
      expect(await notify(fakeSender().sender)).toMatchObject({ ambiguous: 1, sent: 0 });
      expect(await alertRow()).toMatchObject({ status: "ambiguous", last_error: "Worker stopped during delivery" });
    });

    it("does not touch a claim whose lease is still running", async () => {
      await oneAlert();
      await notify(null);
      const { profileId } = await relevance();
      await claimNotification(pool, profileId, "alert", "live-worker", 60);
      const { sender, sent } = fakeSender();
      await notify(sender);
      expect(sent).toHaveLength(0);
      expect(await alertRow()).toMatchObject({ status: "claimed", lease_owner: "live-worker" });
    });

    it("refuses to send after losing a claim", async () => {
      await oneAlert();
      await notify(null);
      const { profileId } = await relevance();
      const claimed = await claimNotification(pool, profileId, "alert", "slow-worker", 60);
      await pool.query(`UPDATE notifications SET lease_owner = 'someone-else'`);
      expect(await markSending(pool, claimed!.id, "slow-worker")).toBe(false);
    });

    it("lets a late acknowledgement settle an ambiguous row", async () => {
      await oneAlert();
      await notify(null);
      const { profileId } = await relevance();
      const claimed = await claimNotification(pool, profileId, "alert", "worker", 60);
      await markSending(pool, claimed!.id, "worker");
      await markAmbiguous(pool, claimed!.id, "worker", "reset");
      await markSent(pool, claimed!.id, "555", null, []);
      expect(await alertRow()).toMatchObject({ status: "sent", message_id: "555", last_error: null });
    });

    it("fails a message Telegram refuses and moves on to the next", async () => {
      await establishBaseline();
      await discover("a", "b");
      await match();
      const { sender, sent } = fakeSender([{ kind: "rejected", detail: "HTTP 400: can't parse entities" }]);
      expect(await notify(sender)).toMatchObject({ status: "partial", failed: 1, sent: 1 });
      expect(sent).toHaveLength(1);
    });

    it("stops on bad credentials without spending an attempt", async () => {
      await oneAlert();
      const summary = await notify(fakeSender([{ kind: "misconfigured", detail: "HTTP 401: Unauthorized" }]).sender);
      expect(summary).toMatchObject({ status: "failed", stopReason: "misconfigured" });
      expect(await alertRow()).toMatchObject({ status: "retry", attempts: 0 });
      const { rows: runs } = await pool.query(`SELECT status FROM notify_runs`);
      expect(runs.at(-1)?.status).toBe("failed");
    });

    it("never stores a credential in an error column", async () => {
      await oneAlert();
      await notify(fakeSender([{ kind: "ambiguous", detail: "failed https://api.telegram.org/bot123456:SECRET/sendMessage" }]).sender);
      expect((await alertRow()).last_error).not.toContain("SECRET");
    });

    it("delivers each message once to concurrent workers", async () => {
      await establishBaseline();
      await discover("a", "b", "c", "d", "e", "f");
      await match();
      const shared = fakeSender();
      await Promise.all([notify(shared.sender), notify(shared.sender), notify(shared.sender)]);
      expect(shared.sent).toHaveLength(6);
      expect(new Set(shared.sent).size).toBe(6);
    });
  });

  describe("without delivery", () => {
    it("records that delivery is not configured and keeps the events", async () => {
      await establishBaseline();
      await discover("a");
      await match();
      expect(await notify(null)).toMatchObject({ status: "not_configured", alerts: 1, sent: 0 });
      expect((await rows()).filter((row) => row.kind === "alert")).toMatchObject([{ status: "pending" }]);
      const { rows: runs } = await pool.query(`SELECT status FROM notify_runs`);
      expect(runs).toEqual([{ status: "not_configured" }]);
    });

    it("sends what piled up once credentials appear", async () => {
      await establishBaseline();
      await discover("a");
      await match();
      await notify(null);
      const { sender, sent } = fakeSender();
      await notify(sender);
      expect(sent).toHaveLength(1);
    });

    it("previews a dry run without sending or keeping a row", async () => {
      await establishBaseline();
      await discover("a");
      await match();
      const { sender, sent } = fakeSender();
      const summary = await notify(sender, { dryRun: true });
      expect(summary).toMatchObject({ status: "dry_run", alerts: 1, sent: 1 });
      expect(sent).toHaveLength(0);
      expect(await rows()).toHaveLength(0);
      expect((await pool.query(`SELECT 1 FROM notification_epochs`)).rowCount).toBe(0);
    });
  });

  describe("maintenance", () => {
    it("removes old operational history and keeps what carries identity", async () => {
      await crawlOnce(snapshot([rawListing("a")]));
      await crawlOnce(snapshot([rawListing("a")]));
      await match();
      await notify(fakeSender().sender);
      await pool.query(`UPDATE crawl_runs SET started_at = now() - interval '200 days'`);
      await pool.query(`UPDATE source_snapshots SET started_at = now() - interval '200 days'`);
      await pool.query(`UPDATE match_runs SET started_at = now() - interval '200 days'`);
      await pool.query(`UPDATE notify_runs SET started_at = now() - interval '200 days'`);

      const summary = await cleanup(pool, 90);
      expect(summary).toMatchObject({ snapshots: 1, crawlRuns: 1, matchRuns: expect.any(Number), notifyRuns: expect.any(Number) });
      const counted = async (table: string) => (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
      expect(await counted("source_snapshots")).toBe(1);
      expect(await counted("notifications")).toBe(1);
      expect(await counted("job_events")).toBeGreaterThan(0);
      expect(await counted("match_results")).toBe(1);
    });

    it("reports stale discovery and work that needs a person", async () => {
      expect((await readHealth(pool, config, 14)).discoveryStale).toBe(true);
      await establishBaseline();
      await discover("a");
      await match();
      await notify(fakeSender([{ kind: "ambiguous", detail: "reset" }]).sender);

      const fresh = await readHealth(pool, config, 14);
      expect(fresh).toMatchObject({ discoveryStale: false, staleSources: 0 });
      expect(renderHealth(fresh)).toContain("1 ambiguous");

      await pool.query(`UPDATE crawl_runs SET finished_at = now() - interval '20 hours'`);
      await pool.query(`UPDATE job_sources SET last_complete_snapshot_at = now() - interval '20 hours'`);
      const stale = await readHealth(pool, config, 14);
      expect(stale).toMatchObject({ discoveryStale: true, staleSources: 1 });
      expect(renderHealth(stale)).toContain("STALE");
    });
  });
});
