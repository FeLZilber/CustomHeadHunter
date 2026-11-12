import { inject } from "vitest";
import type { Connector, CrawlOutcome, CrawlPage, Provider, RawListing } from "../../src/connectors/types";
import { createPool, type Pool } from "../../src/db/pool";
import { HttpClient } from "../../src/http/client";
import { crawl, type CrawlDeps, type CrawlOptions } from "../../src/ingest/crawl";
import { createLogger } from "../../src/logger";

export const openPool = (): Pool => createPool(inject("databaseUrl"), 8);

export async function resetDatabase(pool: Pool) {
  await pool.query(
    `TRUNCATE saved_jobs, notifications, notification_epochs, notify_runs, match_results, match_tasks, match_runs, job_evaluations, profiles, profile_revisions,
              job_events, source_listings, source_snapshots, crawl_runs, canonical_jobs, job_sources, companies, requested_sources
     RESTART IDENTITY CASCADE`,
  );
}

export async function addSource(pool: Pool, company = "Fixture Co", key = "fixture", provider: Provider = "greenhouse") {
  const { rows } = await pool.query(
    `INSERT INTO companies (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [company],
  );
  const { rows: source } = await pool.query(
    `INSERT INTO job_sources (company_id, provider, provider_key, career_url, country_coverage, verified_at,
                              verification_source_url)
     VALUES ($1, $2, $3, 'https://example.test/careers', '{IL}', now(), 'https://example.test/verify')
     RETURNING id`,
    [rows[0].id, provider, key],
  );
  return source[0].id as string;
}

export function rawListing(id: string, overrides: Partial<RawListing> = {}): RawListing {
  return {
    providerJobId: id,
    requisitionId: null,
    title: `QA Automation Engineer ${id}`,
    originalDescription: `<p>Test automation for team ${id}.</p>`,
    descriptionText: `Test automation for team ${id}.`,
    location: "Tel Aviv, Israel",
    extraLocations: [],
    workplaceType: null,
    commitment: null,
    salary: null,
    applicationUrl: `https://example.test/jobs/${id}`,
    publishedAt: null,
    providerUpdatedAt: null,
    ...overrides,
  };
}

export const complete = (listings: number, etag: string | null = null): CrawlOutcome => ({
  kind: "complete",
  pages: 1,
  listings,
  etag,
  httpStatus: 200,
});

export interface Script {
  pages: CrawlPage[];
  outcome: CrawlOutcome;
}

export const snapshot = (listings: RawListing[], etag: string | null = null): Script => ({
  pages: [{ listings, invalidRecords: 0 }],
  outcome: complete(listings.length, etag),
});

/** A connector that plays back one scripted response per crawl and records the ETags it was given. */
export function scriptedConnector(provider: Provider, scripts: Script[]) {
  const etags: Array<string | null> = [];
  const connector: Connector = {
    provider,
    async *crawl(source) {
      etags.push(source.etag);
      const script = scripts.shift();
      if (!script) throw new Error("Connector script exhausted");
      for (const page of script.pages) yield page;
      return script.outcome;
    },
  };
  return { connector, etags };
}

export const crawlOptions = (overrides: Partial<CrawlOptions> = {}): CrawlOptions => ({
  trigger: "test",
  mode: "incremental",
  concurrency: 2,
  timeBudgetSeconds: 60,
  leaseSeconds: 60,
  significantFields: ["title", "locations", "workArrangement", "seniority", "technologies", "experience", "salary"],
  graceSnapshots: 2,
  suspiciousDropRatio: 0.5,
  ...overrides,
});

export function testDeps(pool: Pool, connector: Connector, overrides: Partial<CrawlDeps> = {}): CrawlDeps {
  return {
    pool,
    http: new HttpClient(),
    log: createLogger("error", () => {}),
    connectors: { greenhouse: connector, lever: connector, ashby: connector, workable: connector, jsonld: connector, workday: connector },
    ...overrides,
  };
}

export async function runCrawl(pool: Pool, connector: Connector, overrides: Partial<CrawlOptions> = {}) {
  return crawl(testDeps(pool, connector), crawlOptions(overrides));
}

export async function listingStates(pool: Pool) {
  const { rows } = await pool.query(
    `SELECT provider_job_id, status, missing_snapshots FROM source_listings ORDER BY provider_job_id`,
  );
  return Object.fromEntries(rows.map((row) => [row.provider_job_id, [row.status, row.missing_snapshots]]));
}

export async function eventTypes(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query(`SELECT event_type, lifecycle_cycle FROM job_events ORDER BY id`);
  return rows.map((row) => `${row.event_type}:${row.lifecycle_cycle}`);
}
