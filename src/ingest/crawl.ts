import { randomUUID } from "node:crypto";
import { ashbyConnector } from "../connectors/ashby";
import { greenhouseConnector } from "../connectors/greenhouse";
import { jsonldConnector } from "../connectors/jsonld";
import { leverConnector } from "../connectors/lever";
import { workableConnector } from "../connectors/workable";
import { workdayConnector } from "../connectors/workday";
import type { Connector, CrawlOutcome, CrawlPage, Provider } from "../connectors/types";
import { retryTransient, withTransaction, type Pool } from "../db/pool";
import type { HttpClient } from "../http/client";
import type { Logger } from "../logger";
import { NORMALIZATION_VERSION, normalizeListing, type NormalizedListing } from "../normalize";
import { upsertListing, type ListingChange } from "./persist";
import { reconcileNotModified, reconcileSnapshot, type FreshnessSettings } from "./reconcile";
import {
  assertLease,
  claimSource,
  listEnabledSources,
  lockCompany,
  releaseSource,
  type Source,
  type SourceFilter,
} from "./sources";

export const defaultConnectors: Record<Provider, Connector> = {
  greenhouse: greenhouseConnector,
  lever: leverConnector,
  ashby: ashbyConnector,
  workable: workableConnector,
  jsonld: jsonldConnector,
  workday: workdayConnector,
};

const TRANSACTION_BATCH = 50;

export type CrawlMode = "incremental" | "full";

export interface CrawlOptions extends FreshnessSettings {
  trigger: string;
  mode: CrawlMode;
  filter?: SourceFilter;
  concurrency: number;
  timeBudgetSeconds: number;
  leaseSeconds: number;
  significantFields: string[];
}

export interface CrawlDeps {
  pool: Pool;
  http: HttpClient;
  log: Logger;
  connectors?: Record<Provider, Connector>;
  now?: () => number;
}

export type SnapshotOutcome = "complete" | "partial" | "failed" | "blocked" | "not_modified" | "suspicious" | "skipped";

export interface SourceReport {
  source: string;
  outcome: SnapshotOutcome;
  pages: number;
  seen: number;
  outOfScope: number;
  invalid: number;
  created: number;
  changed: number;
  expired: number;
  error: string | null;
}

export interface CrawlSummary {
  runId: string;
  status: "succeeded" | "partial" | "failed";
  durationMs: number;
  sources: SourceReport[];
  notStarted: number;
}

interface Normalized {
  inScope: NormalizedListing[];
  outOfScope: number;
  invalid: number;
}

function normalizePage(page: CrawlPage): Normalized {
  const inScope: NormalizedListing[] = [];
  let outOfScope = 0;
  let invalid = page.invalidRecords;
  for (const raw of page.listings) {
    let listing: NormalizedListing;
    try {
      listing = normalizeListing(raw);
    } catch {
      invalid += 1;
      continue;
    }
    if (listing.inIsraelScope) inScope.push(listing);
    else outOfScope += 1;
  }
  return { inScope, outOfScope, invalid };
}

/** Listings are committed before the next network request, so a later failure keeps them. */
async function persistBatch(
  pool: Pool,
  source: Source,
  snapshotId: string,
  owner: string,
  listings: NormalizedListing[],
  options: CrawlOptions,
): Promise<Record<ListingChange, number>> {
  return withTransaction(pool, async (client) => {
    await assertLease(client, source.id, owner, options.leaseSeconds);
    await lockCompany(client, source.companyId);
    const counts: Record<ListingChange, number> = { new: 0, changed: 0, unchanged: 0 };
    const context = { source, snapshotId, significantFields: options.significantFields };
    for (const listing of listings) counts[await upsertListing(client, context, listing)] += 1;
    await client.query(
      `UPDATE source_snapshots SET listings_new = listings_new + $2, listings_changed = listings_changed + $3
        WHERE id = $1`,
      [snapshotId, counts.new, counts.changed],
    );
    return counts;
  });
}

async function usesOlderNormalization(pool: Pool, sourceId: string): Promise<boolean> {
  const { rowCount } = await retryTransient(() =>
    pool.query(`SELECT 1 FROM source_listings WHERE source_id = $1 AND normalization_version <> $2 LIMIT 1`, [
      sourceId,
      NORMALIZATION_VERSION,
    ]),
  );
  return (rowCount ?? 0) > 0;
}

interface Finish {
  outcome: Exclude<SnapshotOutcome, "skipped">;
  error: string | null;
  httpStatus: number | null;
}

async function finishSnapshot(pool: Pool, snapshotId: string, report: SourceReport, finish: Finish) {
  await retryTransient(() =>
    pool.query(
      `UPDATE source_snapshots
          SET outcome = $2, error = $3, http_status = $4, pages_fetched = $5, listings_seen = $6,
              listings_out_of_scope = $7, listings_expired = $8, finished_at = now()
        WHERE id = $1`,
      [snapshotId, finish.outcome, finish.error, finish.httpStatus, report.pages, report.seen, report.outOfScope, report.expired],
    ),
  );
}

export async function crawlSource(
  deps: CrawlDeps,
  runId: string,
  source: Source,
  options: CrawlOptions,
  deadline: number,
): Promise<SourceReport> {
  const { pool, http, log } = deps;
  const connector = (deps.connectors ?? defaultConnectors)[source.provider];
  const report: SourceReport = {
    source: `${source.provider}:${source.providerKey}`,
    outcome: "skipped",
    pages: 0,
    seen: 0,
    outOfScope: 0,
    invalid: 0,
    created: 0,
    changed: 0,
    expired: 0,
    error: null,
  };
  const now = deps.now ?? Date.now;
  const owner = `${runId}:${randomUUID()}`;
  if (!(await retryTransient(() => claimSource(pool, source.id, owner, options.leaseSeconds)))) {
    report.error = "Another crawl holds the lease";
    return report;
  }

  const { rows } = await retryTransient(() =>
    pool.query(`INSERT INTO source_snapshots (run_id, source_id) VALUES ($1, $2) RETURNING id`, [runId, source.id]),
  );
  const snapshotId: string = rows[0].id;

  try {
    const stale = options.mode === "full" || (await usesOlderNormalization(pool, source.id));
    const generator = connector.crawl({ providerKey: source.providerKey, etag: stale ? null : source.checkpointEtag }, http);

    let timedOut = false;
    let pagesRead = 0;
    let step = await generator.next();
    while (!step.done) {
      pagesRead += 1;
      const { inScope, outOfScope, invalid } = normalizePage(step.value);
      report.seen += step.value.listings.length;
      report.outOfScope += outOfScope;
      report.invalid += invalid;
      for (let start = 0; start < inScope.length; start += TRANSACTION_BATCH) {
        const counts = await persistBatch(pool, source, snapshotId, owner, inScope.slice(start, start + TRANSACTION_BATCH), options);
        report.created += counts.new;
        report.changed += counts.changed;
      }
      if (now() > deadline) {
        timedOut = true;
        await generator.return(undefined as never);
        break;
      }
      step = await generator.next();
    }

    const outcome: CrawlOutcome = timedOut
      ? { kind: "partial", pages: pagesRead, reason: "Crawl time budget exhausted", httpStatus: null }
      : (step.value as CrawlOutcome);
    report.pages = outcome.pages;

    const finish = await settleOutcome(pool, source, snapshotId, owner, outcome, report, options);
    report.outcome = finish.outcome;
    report.error = finish.error;
    await finishSnapshot(pool, snapshotId, report, finish);
  } catch (error) {
    report.outcome = "failed";
    report.error = String(error);
    log.error("Source crawl failed", { source: report.source, error: report.error });
    await finishSnapshot(pool, snapshotId, report, { outcome: "failed", error: report.error, httpStatus: null }).catch(() => {});
  }
  await retryTransient(() => releaseSource(pool, source.id, owner)).catch(() => {});
  return report;
}

async function settleOutcome(
  pool: Pool,
  source: Source,
  snapshotId: string,
  owner: string,
  outcome: CrawlOutcome,
  report: SourceReport,
  options: CrawlOptions,
): Promise<Finish> {
  if (outcome.kind === "not_modified") {
    report.expired = await withTransaction(pool, async (client) => {
      await assertLease(client, source.id, owner, options.leaseSeconds);
      await lockCompany(client, source.companyId);
      return reconcileNotModified(client, source, snapshotId, options);
    });
    return { outcome: "not_modified", error: null, httpStatus: outcome.httpStatus };
  }
  if (outcome.kind !== "complete") {
    return { outcome: outcome.kind, error: outcome.reason, httpStatus: outcome.httpStatus };
  }
  if (report.invalid > 0) {
    return { outcome: "partial", error: `${report.invalid} listings failed normalization`, httpStatus: outcome.httpStatus };
  }
  const result = await withTransaction(pool, async (client) => {
    await assertLease(client, source.id, owner, options.leaseSeconds);
    await lockCompany(client, source.companyId);
    return reconcileSnapshot(client, source, snapshotId, outcome.listings, outcome.etag, options);
  });
  report.expired = result.expired;
  return result.outcome === "complete"
    ? { outcome: "complete", error: null, httpStatus: outcome.httpStatus }
    : { outcome: "suspicious", error: result.reason, httpStatus: outcome.httpStatus };
}

/** Crashed runs leave these behind. Older than any lease, so nothing live is touched. */
async function closeAbandoned(pool: Pool, olderThanSeconds: number): Promise<void> {
  await pool.query(
    `UPDATE source_snapshots SET outcome = 'failed', error = 'Abandoned by a previous run', finished_at = now()
      WHERE outcome = 'running' AND started_at < now() - make_interval(secs => $1)`,
    [olderThanSeconds],
  );
  await pool.query(
    `UPDATE crawl_runs SET status = 'failed', finished_at = now()
      WHERE status = 'running' AND started_at < now() - make_interval(secs => $1)`,
    [olderThanSeconds],
  );
}

const SOUND: SnapshotOutcome[] = ["complete", "not_modified"];

export async function crawl(deps: CrawlDeps, options: CrawlOptions): Promise<CrawlSummary> {
  const { pool, log } = deps;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + options.timeBudgetSeconds * 1000;

  await retryTransient(() => closeAbandoned(pool, options.leaseSeconds * 2));
  const { rows } = await retryTransient(() =>
    pool.query(`INSERT INTO crawl_runs (trigger, mode) VALUES ($1, $2) RETURNING id`, [options.trigger, options.mode]),
  );
  const runId: string = rows[0].id;
  const queue = await retryTransient(() => listEnabledSources(pool, options.filter));
  const sources: SourceReport[] = [];

  const worker = async () => {
    for (let source = queue.shift(); source; source = queue.shift()) {
      if (now() > deadline) {
        queue.unshift(source);
        return;
      }
      const report = await crawlSource(deps, runId, source, options, deadline);
      sources.push(report);
      log.info("Source crawled", { ...report });
    }
  };
  await Promise.all(Array.from({ length: options.concurrency }, worker));

  const notStarted = queue.length;
  const sound = sources.filter((report) => SOUND.includes(report.outcome)).length;
  const status = sound === 0 && sources.length + notStarted > 0
    ? "failed"
    : sound === sources.length && notStarted === 0
      ? "succeeded"
      : "partial";
  const summary: CrawlSummary = { runId, status, durationMs: now() - startedAt, sources, notStarted };
  await retryTransient(() =>
    pool.query(`UPDATE crawl_runs SET status = $2, finished_at = now(), summary = $3 WHERE id = $1`, [
      runId,
      status,
      JSON.stringify(summary),
    ]),
  );
  return summary;
}

/** Fetches and normalizes without writing anything, to preview a connector. */
export async function dryRunCrawl(deps: CrawlDeps, options: CrawlOptions) {
  const sources = await listEnabledSources(deps.pool, options.filter);
  const reports = [];
  for (const source of sources) {
    const connector = (deps.connectors ?? defaultConnectors)[source.provider];
    const generator = connector.crawl({ providerKey: source.providerKey, etag: null }, deps.http);
    let seen = 0;
    let inScope = 0;
    let step = await generator.next();
    while (!step.done) {
      seen += step.value.listings.length;
      inScope += normalizePage(step.value).inScope.length;
      step = await generator.next();
    }
    reports.push({ source: `${source.provider}:${source.providerKey}`, outcome: step.value.kind, seen, inScope });
  }
  return reports;
}
