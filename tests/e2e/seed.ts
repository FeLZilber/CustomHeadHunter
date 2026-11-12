import type { Connector, RawListing } from "../../src/connectors/types";
import { scriptedFacts } from "../scripted-facts";
import type { Pool } from "../../src/db/pool";
import { HttpClient } from "../../src/http/client";
import { crawl, type CrawlOptions } from "../../src/ingest/crawl";
import { createLogger } from "../../src/logger";
import { buildMatchConfig } from "../../src/match/config";
import { evaluateJobs } from "../../src/match/queue";
import { runMatch } from "../../src/match/runner";
import { buildRelevance } from "../../src/notify/outbox";
import { runNotify } from "../../src/notify/sender";
import { ensureProfile } from "../../src/profile/store";
import { HOSTILE_DESCRIPTION, TITLES } from "./constants";

const config = buildMatchConfig({ OLLAMA_NUM_CTX: 3072, MAX_OUTPUT_TOKENS: 800, MAX_JOB_INPUT_TOKENS: 1600 });
const log = createLogger("error", () => {});

const listing = (id: string, title: string, overrides: Partial<RawListing> = {}): RawListing => ({
  providerJobId: id,
  requisitionId: null,
  title,
  originalDescription: "<p>Test automation.</p>",
  descriptionText: "Test automation with Playwright.",
  location: "Tel Aviv, Israel",
  extraLocations: [],
  workplaceType: null,
  commitment: null,
  salary: null,
  applicationUrl: `https://example.test/jobs/${id}`,
  publishedAt: null,
  providerUpdatedAt: null,
  ...overrides,
});

const crawlOptions: CrawlOptions = {
  trigger: "test",
  mode: "incremental",
  concurrency: 2,
  timeBudgetSeconds: 60,
  leaseSeconds: 60,
  significantFields: ["title", "locations", "workArrangement", "seniority", "technologies", "experience", "salary"],
  graceSnapshots: 2,
  suspiciousDropRatio: 0.5,
};

async function addSource(pool: Pool, company: string, key: string) {
  const { rows } = await pool.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [company]);
  await pool.query(
    `INSERT INTO job_sources (company_id, provider, provider_key, career_url, country_coverage, verified_at, verification_source_url)
     VALUES ($1, 'greenhouse', $2, 'https://example.test/careers', '{IL}', now(), 'https://example.test/verify')`,
    [rows[0].id, key],
  );
}

function connectorFor(listings: RawListing[]): Connector {
  return {
    provider: "greenhouse",
    async *crawl(source) {
      if (source.providerKey === "broken") throw new Error("Board unreachable");
      yield { listings, invalidRecords: 0 };
      return { kind: "complete", pages: 1, listings: listings.length, etag: null, httpStatus: 200 };
    },
  };
}

const facts = scriptedFacts();

const reply = (skills: number) =>
  JSON.stringify({
    role_category: "qa_automation",
    matching_requirements: [{ requirement: "Automation", evidence: "Test automation" }],
    missing_requirements: [{ requirement: "Go", evidence: "invented quote", candidate_fact: null }],
    unknown_requirements: [{ requirement: "Clearance", reason: "The profile does not mention it" }],
    concerns: [],
    explanation: "A good fit for the automation team.",
    points: { role: 40, skills, experience: 8, location: 5, industry: 2 },
  });

/** Reaches every state through the same crawl, evaluate, match and notify code production runs. */
export async function seedFixtures(pool: Pool) {
  await addSource(pool, "Fixture Labs", "fixture");
  await addSource(pool, "Broken Co", "broken");

  const listings = [
    listing("hostile", TITLES.hostile, { descriptionText: HOSTILE_DESCRIPTION }),
    listing("hebrew", TITLES.hebrew, { location: "תל אביב", descriptionText: "Test automation בעברית ובאנגלית." }),
    listing("low", TITLES.low, { publishedAt: new Date("2020-03-15T12:00:00Z") }),
    listing("failed", TITLES.failed),
    listing("filtered", TITLES.filtered, { descriptionText: "Run the office." }),
    listing("adjacent", TITLES.adjacent, {
      descriptionText:
        "Operate our cloud infrastructure, maintain the deployment pipelines, and keep the platform reliable. " +
        "You will own monitoring, incident response and capacity planning across several regions for a growing product team.",
    }),
  ];
  const deps = { pool, http: new HttpClient(), log, connectors: { greenhouse: connectorFor(listings), lever: connectorFor(listings), ashby: connectorFor(listings), workable: connectorFor(listings), jsonld: connectorFor(listings), workday: connectorFor(listings) } };
  await crawl(deps, crawlOptions);

  const profile = await ensureProfile(pool);
  await evaluateJobs(pool, config, profile, 1000);
  const chatResult = { doneReason: "stop", totalMs: 1, loadMs: 0, promptTokens: 1, promptMs: 0, outputTokens: 1, outputMs: 0 };
  const matched = await runMatch(
    {
      pool,
      log,
      scoreFacts: facts.scoreFacts,
      model: {
        modelDigest: async () => config.modelDigest,
        async chat({ messages }) {
          const prompt = messages.map((message) => message.content).join("\n");
          if (prompt.includes(TITLES.failed)) return { ...chatResult, content: "not json" };
          const content = reply(prompt.includes(TITLES.low) ? 5 : 25);
          facts.observe(content);
          return { ...chatResult, content };
        },
      },
    },
    { trigger: "test", config, maxJobs: 10, timeBudgetSeconds: 300, inferenceTimeoutSeconds: 60, maxAttempts: 1, retryBaseSeconds: 0 },
  );
  if (matched.succeeded !== 3 || matched.exhausted !== 1) throw new Error(`Unexpected fixture match: ${JSON.stringify(matched)}`);

  await runNotify(
    { pool, sender: { send: async () => ({ kind: "ambiguous", detail: "Connection lost" }) }, log, sleep: async () => {} },
    {
      trigger: "test",
      relevance: buildRelevance(profile, config),
      dryRun: false,
      maxAlerts: 5,
      maxDigests: 2,
      digestSize: 5,
      maxAttempts: 3,
      retryBaseSeconds: 60,
      timeBudgetSeconds: 60,
    },
  );

  // Arrives after the match run, so it stays pending.
  await crawl(
    { ...deps, connectors: { greenhouse: connectorFor([...listings, listing("pending", TITLES.pending)]), lever: deps.connectors.lever, ashby: deps.connectors.ashby, workable: deps.connectors.workable, jsonld: deps.connectors.jsonld, workday: deps.connectors.workday } },
    crawlOptions,
  );
  await evaluateJobs(pool, config, profile, 1000);
}
