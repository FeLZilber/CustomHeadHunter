import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadContext, getJob, parseFilters, PAGE_SIZE, readStatus, readDismissals, readRejections, setMissed, searchJobs, setApplied, setDismissed, setSaved, type ViewContext } from "../../src/dashboard/queries";
import { migrate } from "../../src/db/migrate";
import type { Pool } from "../../src/db/pool";
import { createLogger } from "../../src/logger";
import { buildMatchConfig, hashMatchConfig } from "../../src/match/config";
import type { ChatResult } from "../../src/match/ollama-client";
import { evaluateJobs } from "../../src/match/queue";
import { runMatch, type MatchDeps } from "../../src/match/runner";
import { buildRelevance } from "../../src/notify/outbox";
import { runNotify } from "../../src/notify/sender";
import { ensureProfile, saveProfile } from "../../src/profile/store";
import { scriptedFacts } from "../scripted-facts";
import { addSource, openPool, rawListing, resetDatabase, runCrawl, scriptedConnector, snapshot } from "./helpers";

const config = buildMatchConfig({ OLLAMA_NUM_CTX: 3072, MAX_OUTPUT_TOKENS: 800, MAX_JOB_INPUT_TOKENS: 1600 });

const modelReply = (skills = 25) =>
  JSON.stringify({
    role_category: "qa_automation",
    matching_requirements: [{ requirement: "Automation", evidence: "Test automation" }],
    missing_requirements: [{ requirement: "Go", evidence: "invented quote", candidate_fact: null }],
    unknown_requirements: [],
    concerns: [],
    explanation: "A good fit.",
    points: { role: 40, skills, experience: 8, location: 5, industry: 2 },
  });

const facts = scriptedFacts();

const fakeModel = (reply: (prompt: string) => string): MatchDeps["model"] => ({
  async modelDigest() {
    return config.modelDigest;
  },
  async chat(request): Promise<ChatResult> {
    const content = reply(request.messages.map((message) => message.content).join("\n"));
    facts.observe(content);
    return { content, doneReason: "stop", totalMs: 1, loadMs: 0, promptTokens: 1, promptMs: 0, outputTokens: 1, outputMs: 0 };
  },
});

describe("dashboard queries", () => {
  let pool: Pool;
  const log = createLogger("error", () => {});

  beforeAll(async () => {
    pool = openPool();
    await migrate(pool);
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    await addSource(pool);
  });
  afterAll(() => pool.end());

  const crawlListings = async (...listings: ReturnType<typeof rawListing>[]) => {
    const { connector } = scriptedConnector("greenhouse", [snapshot(listings)]);
    await runCrawl(pool, connector);
  };

  const evaluate = async () => evaluateJobs(pool, config, await ensureProfile(pool), 1000);

  async function match(reply: (prompt: string) => string = () => modelReply(), maxJobs = 50, maxAttempts = 3) {
    await evaluate();
    return runMatch(
      { pool, model: fakeModel(reply), log, scoreFacts: facts.scoreFacts },
      { trigger: "test", config, maxJobs, timeBudgetSeconds: 600, inferenceTimeoutSeconds: 180, maxAttempts, retryBaseSeconds: 0 },
    );
  }

  const context = async (): Promise<ViewContext> => ({ profile: await ensureProfile(pool), configHash: hashMatchConfig(config) });
  const search = async (params: Record<string, string> = {}, only?: "saved" | "applied" | "dismissed" | "filtered" | "flagged" | "near") =>
    searchJobs(pool, await context(), parseFilters(params), only);
  const titles = async (params: Record<string, string> = {}) => (await search(params)).jobs.map((job) => job.title);
  const onlyJob = async () => (await search({ status: "all" })).jobs[0]!;

  describe("search", () => {
    it("matches title, company and location without regard to case", async () => {
      await crawlListings(rawListing("a", { title: "QA Automation Lead" }), rawListing("b", { title: "SDET Automation", location: "Haifa, Israel" }));
      expect(await titles({ q: "qa auto" })).toEqual(["QA Automation Lead"]);
      expect(await titles({ company: "fixture" })).toHaveLength(2);
      expect(await titles({ location: "haifa" })).toEqual(["SDET Automation"]);
    });

    it("finds Hebrew text", async () => {
      await crawlListings(rawListing("he", { title: "בודק/ת תוכנה אוטומציה", location: "תל אביב" }));
      expect(await titles({ q: "בודק" })).toHaveLength(1);
      expect(await titles({ location: "תל אביב" })).toHaveLength(1);
    });

    it("treats LIKE wildcards in a search term as text", async () => {
      await crawlListings(rawListing("a", { title: "QA Automation Engineer" }), rawListing("b", { title: "QA_Automation 100% Remote" }));
      expect(await titles({ q: "%" })).toEqual(["QA_Automation 100% Remote"]);
      expect(await titles({ q: "QA_A" })).toEqual(["QA_Automation 100% Remote"]);
      expect(await titles({ q: "\\" })).toEqual([]);
    });

    it("binds hostile input instead of building SQL from it", async () => {
      await crawlListings(rawListing("a"));
      expect(await titles({ q: "'; DROP TABLE canonical_jobs; --" })).toEqual([]);
      expect(await titles()).toHaveLength(1);
    });

    it("filters by extracted technology", async () => {
      await crawlListings(
        rawListing("a", { descriptionText: "We use Playwright and TypeScript." }),
        rawListing("b", { descriptionText: "We use Selenium." }),
      );
      const { jobs } = await search({ technology: "playwright" });
      expect(jobs.map((job) => job.id)).toHaveLength(1);
      expect(jobs[0]!.technologies).toEqual(expect.arrayContaining(["Playwright", "TypeScript"]));
    });

    it("shows active jobs by default and expired ones on request", async () => {
      await crawlListings(rawListing("a"), rawListing("b", { title: "Expired Role QA Automation" }));
      await pool.query(`UPDATE canonical_jobs SET status = 'expired' WHERE title LIKE 'Expired%'`);
      expect(await titles()).toEqual(["QA Automation Engineer a"]);
      expect(await titles({ status: "expired" })).toEqual(["Expired Role QA Automation"]);
      expect(await titles({ status: "all" })).toHaveLength(2);
    });

    it("pages through results and says when more remain", async () => {
      await crawlListings(...Array.from({ length: PAGE_SIZE + 2 }, (_, index) => rawListing(`job-${index}`)));
      const first = await search({ sort: "latest" });
      const second = await search({ sort: "latest", page: "2" });
      expect(first.jobs).toHaveLength(PAGE_SIZE);
      expect(first.hasMore).toBe(true);
      expect(second.jobs).toHaveLength(2);
      expect(second.hasMore).toBe(false);
      expect(new Set([...first.jobs, ...second.jobs].map((job) => job.id)).size).toBe(PAGE_SIZE + 2);
    });

    it("sorts by current score, with unscored jobs after", async () => {
      await crawlListings(rawListing("low"), rawListing("high"));
      await match((prompt) => modelReply(prompt.includes("Engineer high") ? 25 : 5));
      await crawlListings(rawListing("low"), rawListing("high"), rawListing("new"));
      await evaluate();
      expect(await titles()).toEqual(["QA Automation Engineer high", "QA Automation Engineer low", "QA Automation Engineer new"]);
      expect((await titles({ sort: "latest" }))[0]).toBe("QA Automation Engineer new");
    });

    it("shows and filters by posting date, using the found date when none is given", async () => {
      const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
      await crawlListings(
        rawListing("recent", { publishedAt: daysAgo(5) }),
        rawListing("month", { publishedAt: daysAgo(20) }),
        rawListing("old", { publishedAt: daysAgo(200) }),
        rawListing("undated"),
      );
      const short = (list: string[]) => list.map((title) => title.replace("QA Automation Engineer ", "")).sort();
      expect(short(await titles({ posted: "14" }))).toEqual(["recent", "undated"]);
      expect(short(await titles({ posted: "30" }))).toEqual(["month", "recent", "undated"]);
      expect(short(await titles())).toEqual(["month", "old", "recent", "undated"]);
      expect(short(await titles({ posted: "nonsense" }))).toEqual(["month", "old", "recent", "undated"]);
      const { jobs } = await search({ sort: "posted" });
      expect(jobs.at(-1)?.title).toBe("QA Automation Engineer old");
      expect(jobs.find((job) => job.title.endsWith("undated"))?.postedAt).toBeNull();
      expect(jobs.find((job) => job.title.endsWith("recent"))?.postedAt).toBeInstanceOf(Date);
    });
  });

  describe("match states", () => {
    it("reports a job no evaluation has reached", async () => {
      await crawlListings(rawListing("a"));
      expect(await onlyJob()).toMatchObject({ matchState: "not_evaluated", score: null });
    });

    it("reports a job waiting for the model", async () => {
      await crawlListings(rawListing("a"));
      await evaluate();
      expect(await onlyJob()).toMatchObject({ matchState: "pending", score: null });
    });

    it("reports a current result with its score", async () => {
      await crawlListings(rawListing("a"));
      await match();
      expect(await onlyJob()).toMatchObject({ matchState: "current", score: 80, recommendation: "strong_match" });
    });

    it("reports a rule rejection and its reasons, with no score", async () => {
      await crawlListings(rawListing("office", { title: "Office Manager" }));
      await match();
      const job = await onlyJob();
      expect(job).toMatchObject({ matchState: "filtered", score: null, recommendation: null });
      expect(job.reasonCodes.length).toBeGreaterThan(0);
    });

    it("reports an exhausted evaluation as failed, not as a score of zero", async () => {
      await crawlListings(rawListing("a"));
      await match(() => "not json", 50, 1);
      expect(await onlyJob()).toMatchObject({ matchState: "failed", score: null });
    });

    it("marks an old result out of date when the profile changes, and keeps it out of score filters", async () => {
      await crawlListings(rawListing("a"));
      await match();
      const { matching } = await ensureProfile(pool);
      await saveProfile(pool, { matching: { ...matching, preferredIndustries: ["Logistics"] } });

      expect(await onlyJob()).toMatchObject({ matchState: "stale", score: 80 });
      expect((await search({ minScore: "1" })).jobs).toEqual([]);
      expect((await search({ match: "stale" })).jobs).toHaveLength(1);
    });

    it("shows a changed job as pending and labels its earlier score", async () => {
      await crawlListings(rawListing("a"));
      await match();
      await crawlListings(rawListing("a", { descriptionText: "Test automation, now with new duties in a new team." }));
      await evaluate();
      expect(await onlyJob()).toMatchObject({ matchState: "pending", score: 80 });
    });

    it("hides an older score once the job is filtered out", async () => {
      await crawlListings(rawListing("a"));
      await match();
      const { matching } = await ensureProfile(pool);
      await saveProfile(pool, { matching: { ...matching, hardRules: { ...matching.hardRules, excludedTitleTerms: ["Engineer"] } } });
      await evaluate();
      const job = await onlyJob();
      expect(job).toMatchObject({ matchState: "filtered", score: null });
      expect((await getJob(pool, await context(), job.id))!.match).toBeNull();
    });

    it("takes the configuration from the newest evaluation", async () => {
      await crawlListings(rawListing("a"));
      await match();
      const loaded = await loadContext(pool);
      expect(loaded.configHash).toBe(hashMatchConfig(config));
      expect((await searchJobs(pool, loaded, parseFilters({}))).jobs[0]!.matchState).toBe("current");
    });
  });

  describe("job detail", () => {
    it("returns the description, evidence checks and history", async () => {
      await crawlListings(rawListing("a"));
      await match();
      const { id } = await onlyJob();
      const job = await getJob(pool, await context(), id);

      expect(job!.description).toContain("Test automation for team a");
      expect(job!.match).toMatchObject({ unverified: ["invented quote"], evidenceTotal: 2, evidenceLiteral: 1, inputTruncated: false });
      expect(job!.match!.response.explanation).toBe("A good fit.");
      expect(job!.events.map((event) => event.type)).toContain("discovered");
    });

    it("returns nothing for an unknown id", async () => {
      expect(await getJob(pool, await context(), "999999")).toBeNull();
    });
  });

  describe("saved jobs", () => {
    it("saves and removes idempotently, and keeps a saved job visible after it expires", async () => {
      await crawlListings(rawListing("a"));
      const { id } = await onlyJob();
      const { profileId } = await ensureProfile(pool);

      await setSaved(pool, profileId, id, true);
      await setSaved(pool, profileId, id, true);
      await pool.query(`UPDATE canonical_jobs SET status = 'expired'`);
      expect((await search({ status: "all" }, "saved")).jobs.map((job) => job.saved)).toEqual([true]);

      await setSaved(pool, profileId, id, false);
      await setSaved(pool, profileId, id, false);
      expect((await search({ status: "all" }, "saved")).jobs).toEqual([]);
    });
  });

  describe("applied jobs", () => {
    it("marks and unmarks idempotently, keeps the first date, and survives expiry", async () => {
      await crawlListings(rawListing("a"), rawListing("b"));
      const { rows } = await pool.query(`SELECT id FROM canonical_jobs ORDER BY id`);
      const [first, second] = rows.map((row) => row.id as string) as [string, string];
      const { profileId } = await ensureProfile(pool);

      await setApplied(pool, profileId, first, true);
      const { rows: before } = await pool.query(`SELECT applied_at FROM job_applications`);
      await setApplied(pool, profileId, first, true);
      const { rows: after } = await pool.query(`SELECT applied_at FROM job_applications`);
      expect(after).toEqual(before);

      await pool.query(`UPDATE canonical_jobs SET status = 'expired' WHERE id = $1`, [first]);
      const applied = (await search({ status: "all" }, "applied")).jobs;
      expect(applied.map((job) => job.id)).toEqual([first]);
      expect(applied[0]?.appliedAt).toBeInstanceOf(Date);
      expect(applied[0]?.status).toBe("expired");
      expect((await search({ status: "all" })).jobs.find((job) => job.id === second)?.appliedAt).toBeNull();
      expect((await getJob(pool, await context(), first))?.appliedAt).toBeInstanceOf(Date);

      await setApplied(pool, profileId, first, false);
      await setApplied(pool, profileId, first, false);
      expect((await search({ status: "all" }, "applied")).jobs).toEqual([]);
    });

    it("does not touch saved state", async () => {
      await crawlListings(rawListing("a"));
      const { id } = await onlyJob();
      const { profileId } = await ensureProfile(pool);
      await setApplied(pool, profileId, id, true);
      expect((await search({ status: "all" }, "saved")).jobs).toEqual([]);
      await setSaved(pool, profileId, id, true);
      await setApplied(pool, profileId, id, false);
      expect((await search({ status: "all" }, "saved")).jobs.map((job) => job.saved)).toEqual([true]);
    });
  });

  describe("dismissed jobs", () => {
    it("hides a dismissed job from the main list, keeps it in its own, and restores it", async () => {
      await crawlListings(rawListing("a"), rawListing("b"));
      const { rows } = await pool.query(`SELECT id FROM canonical_jobs ORDER BY id`);
      const [first, second] = rows.map((row) => row.id as string) as [string, string];
      const { profileId } = await ensureProfile(pool);

      await setDismissed(pool, profileId, first, "wrong_role");
      expect((await search({ status: "all" })).jobs.map((job) => job.id)).toEqual([second]);
      const dismissed = (await search({ status: "all" }, "dismissed")).jobs;
      expect(dismissed.map((job) => [job.id, job.dismissedReason])).toEqual([[first, "wrong_role"]]);

      await setDismissed(pool, profileId, first, null);
      await setDismissed(pool, profileId, first, null);
      expect((await search({ status: "all" }, "dismissed")).jobs).toEqual([]);
      expect((await search({ status: "all" })).jobs).toHaveLength(2);
    });

    it("changes the reason without moving the date, and does not hide a saved job from the saved list", async () => {
      await crawlListings(rawListing("a"));
      const { id } = await onlyJob();
      const { profileId } = await ensureProfile(pool);

      await setDismissed(pool, profileId, id, "wrong_role");
      const { rows: before } = await pool.query(`SELECT dismissed_at FROM dismissed_jobs`);
      await setDismissed(pool, profileId, id, "wrong_location");
      const { rows: after } = await pool.query(`SELECT dismissed_at, reason FROM dismissed_jobs`);
      expect(after).toEqual([{ dismissed_at: before[0]?.dismissed_at, reason: "wrong_location" }]);

      await setSaved(pool, profileId, id, true);
      expect((await search({ status: "all" }, "saved")).jobs.map((job) => job.id)).toEqual([id]);
      expect((await getJob(pool, await context(), id))?.dismissedReason).toBe("wrong_location");
    });

    it("rejects a reason the list does not know", async () => {
      await crawlListings(rawListing("a"));
      const { id } = await onlyJob();
      const { profileId } = await ensureProfile(pool);
      await expect(setDismissed(pool, profileId, id, "boring" as never)).rejects.toThrow();
    });

    it("tallies reasons and companies dismissed more than once", async () => {
      await crawlListings(rawListing("a"), rawListing("b"), rawListing("c"));
      const { rows } = await pool.query(`SELECT id FROM canonical_jobs ORDER BY id`);
      const ids = rows.map((row) => row.id as string);
      const { profileId } = await ensureProfile(pool);
      await setDismissed(pool, profileId, ids[0]!, "wrong_role");
      await setDismissed(pool, profileId, ids[1]!, "wrong_role");
      await setDismissed(pool, profileId, ids[2]!, "wrong_seniority");

      const summary = await readDismissals(pool, profileId);
      expect(summary.total).toBe(3);
      expect(summary.byReason).toEqual([{ reason: "wrong_role", count: 2 }, { reason: "wrong_seniority", count: 1 }]);
      expect(summary.repeatCompanies).toHaveLength(1);
      expect(summary.repeatCompanies[0]?.count).toBe(3);
    });
  });

  describe("near misses", () => {
    it("lists current results between the floor and the alert threshold, and not dismissed ones", async () => {
      await crawlListings(rawListing("strong"), rawListing("near"), rawListing("low"));
      await match((prompt) => modelReply(prompt.includes("QA Automation Engineer near") ? 10 : prompt.includes("QA Automation Engineer low") ? -20 : 25));
      expect((await search({ status: "all" }, "near")).jobs.map((job) => [job.title, job.score])).toEqual([["QA Automation Engineer near", 65]]);

      const { profileId } = await ensureProfile(pool);
      const [near] = (await search({ status: "all" }, "near")).jobs;
      await setDismissed(pool, profileId, near!.id, "wrong_role");
      expect((await search({ status: "all" }, "near")).jobs).toEqual([]);
    });
  });

  describe("rejection audit", () => {
    it("tallies filter reasons for active filtered jobs, and lists them by reason", async () => {
      await crawlListings(rawListing("office", { title: "Office Manager" }), rawListing("hr", { title: "HR Manager" }), rawListing("qa"));
      await match();
      const summary = await readRejections(pool, await context());
      expect(summary.total).toBe(2);
      expect(summary.byReason.map((row) => row.reason)).toEqual(["title_other_discipline"]);
      expect(summary.byReason[0]?.count).toBe(2);

      const filtered = (await search({ status: "all" }, "filtered")).jobs;
      expect(filtered.map((job) => job.title).sort()).toEqual(["HR Manager", "Office Manager"]);
      expect((await search({ status: "all", reason: "title_other_discipline" }, "filtered")).jobs).toHaveLength(2);
      expect((await search({ status: "all", reason: "no_qa_signal" }, "filtered")).jobs).toHaveLength(0);
    });

    it("marks role-only rejections with an adjacent title as adjacent, and lists them by tier", async () => {
      const description = "We keep our cloud platform running and reliable for every customer, around the clock. ".repeat(4);
      await crawlListings(
        rawListing("office", { title: "Office Manager" }),
        rawListing("devops", { title: "DevOps Engineer", descriptionText: description }),
        rawListing("abroad", { title: "DevOps Engineer Abroad", descriptionText: description, location: "Berlin, Germany", workplaceType: "remote" }),
      );
      await match();
      const filtered = (await search({ status: "all" }, "filtered")).jobs;
      const tierOf = (title: string) => filtered.find((job) => job.title === title)?.tier;
      expect(tierOf("DevOps Engineer")).toBe("adjacent");
      expect(tierOf("Office Manager")).toBeNull();
      expect((await search({ status: "all", tier: "adjacent" }, "filtered")).jobs.map((job) => job.title)).toEqual(["DevOps Engineer"]);
      expect((await readRejections(pool, await context())).adjacent).toBe(1);

      const { profileId } = await ensureProfile(pool);
      expect(profileId).toBeTruthy();
      await saveProfile(pool, { preferences: { adjacentTitles: [] } });
      expect((await search({ status: "all", tier: "adjacent" }, "filtered")).jobs).toEqual([]);
      expect((await readRejections(pool, await context())).adjacent).toBe(0);
    });

    it("flags and unflags a wrongly filtered job idempotently, and leaves dismissed jobs out", async () => {
      await crawlListings(rawListing("office", { title: "Office Manager" }), rawListing("hr", { title: "HR Manager" }));
      await match();
      const { profileId } = await ensureProfile(pool);
      const [office, hr] = (await search({ status: "all" }, "filtered")).jobs;

      await setMissed(pool, profileId, office!.id, true);
      await setMissed(pool, profileId, office!.id, true);
      expect((await search({ status: "all" }, "flagged")).jobs.map((job) => job.id)).toEqual([office!.id]);
      const flaggedSummary = await readRejections(pool, await context());
      expect(flaggedSummary.flagged).toBe(1);
      expect(flaggedSummary.flaggedByReason).toEqual([{ reason: "title_other_discipline", count: 1 }]);

      await setMissed(pool, profileId, office!.id, false);
      await setMissed(pool, profileId, office!.id, false);
      expect((await search({ status: "all" }, "flagged")).jobs).toEqual([]);

      await setDismissed(pool, profileId, hr!.id, "other");
      expect((await readRejections(pool, await context())).total).toBe(1);
    });
  });

  describe("status", () => {
    it("reports failed sources, unresolved deliveries, and a run stopped by its job limit", async () => {
      await addSource(pool, "Broken Co", "broken");
      const { connector } = scriptedConnector("greenhouse", [snapshot([rawListing("a"), rawListing("b")])]);
      const failing = {
        ...connector,
        async *crawl(source: { providerKey: string; etag: string | null }, http: never) {
          if (source.providerKey === "broken") throw new Error("Board unreachable");
          return yield* connector.crawl(source, http);
        },
      };
      await runCrawl(pool, failing as typeof connector);
      const summary = await match(undefined, 1);
      expect(summary.stopReason).toBe("job_cap");

      const relevance = buildRelevance(await ensureProfile(pool), config);
      await match();
      await runNotify(
        { pool, sender: { send: async () => ({ kind: "ambiguous", detail: "Connection lost" }) }, log, sleep: async () => {} },
        { trigger: "test", relevance, dryRun: false, maxAlerts: 5, maxDigests: 2, digestSize: 5, maxAttempts: 3, retryBaseSeconds: 60, timeBudgetSeconds: 60 },
      );

      const status = await readStatus(pool, await context(), 14);
      expect(status.sourceProblems).toEqual([expect.objectContaining({ company: "Broken Co", outcome: "failed", provider: "greenhouse" })]);
      expect(status.deliveryProblems).toEqual([expect.objectContaining({ status: "ambiguous", kind: "digest", error: "Connection lost" })]);
      expect(status.latestMatch).toMatchObject({ status: "succeeded", stopReason: "queue_empty", succeeded: 1 });
      expect(status.health.activeJobs).toBe(2);
    });

    it("works on an empty database", async () => {
      const status = await readStatus(pool, await loadContext(pool), 14);
      expect(status).toMatchObject({ sourceProblems: [], deliveryProblems: [], latestMatch: null });
      expect(status.health.discoveryStale).toBe(true);
    });
  });
});
