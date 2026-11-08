import { retryTransient, type Pool } from "../db/pool";
import { readAiMinutesThisMonth, readBacklogFor, type Backlog } from "../match/queue";
import { readOutbox } from "../notify/outbox";

export interface CleanupSummary {
  snapshots: number;
  crawlRuns: number;
  matchRuns: number;
  notifyRuns: number;
  tasks: number;
}

/**
 * Removes operational history past retention. Jobs, events, results and
 * notifications stay: they carry identity, and deleting one could replay an alert.
 */
export async function cleanup(pool: Pool, retentionDays: number): Promise<CleanupSummary> {
  const remove = async (sql: string) => {
    const { rowCount } = await retryTransient(() => pool.query(sql, [retentionDays]));
    return rowCount ?? 0;
  };
  const expired = (column: string) => `${column} < now() - make_interval(days => $1)`;
  return {
    snapshots: await remove(
      `DELETE FROM source_snapshots s WHERE ${expired("s.started_at")}
         AND NOT EXISTS (SELECT 1 FROM source_listings l WHERE l.last_seen_snapshot_id = s.id)`,
    ),
    crawlRuns: await remove(
      `DELETE FROM crawl_runs r WHERE ${expired("r.started_at")} AND r.status <> 'running'
         AND NOT EXISTS (SELECT 1 FROM source_snapshots s WHERE s.run_id = r.id)`,
    ),
    matchRuns: await remove(`DELETE FROM match_runs WHERE ${expired("started_at")} AND status <> 'running'`),
    notifyRuns: await remove(`DELETE FROM notify_runs WHERE ${expired("started_at")} AND status <> 'running'`),
    tasks: await remove(
      `DELETE FROM match_tasks t WHERE ${expired("t.updated_at")} AND t.status = 'superseded'
         AND NOT EXISTS (SELECT 1 FROM match_results r WHERE r.task_id = t.id)`,
    ),
  };
}

export interface Health {
  checkedAt: Date;
  lastSuccessfulCrawl: Date | null;
  lastCrawl: { status: string; finishedAt: Date | null } | null;
  discoveryStale: boolean;
  staleSources: number;
  activeJobs: number;
  backlog: Backlog;
  aiMinutesThisMonth: number;
  outbox: Record<string, number>;
  lastNotify: { status: string; finishedAt: Date | null } | null;
}

/**
 * Discovery is stale when no crawl succeeded (fully or partially) within `staleHours`,
 * or none ever did. Failed and still-running crawls never make it fresh.
 */
export function isDiscoveryStale(lastSuccessfulCrawl: Date | null, checkedAt: Date, staleHours: number): boolean {
  return !lastSuccessfulCrawl || checkedAt.getTime() - lastSuccessfulCrawl.getTime() > staleHours * 3_600_000;
}

/** A partial crawl still reconciled the sources it reached, so it counts as discovery having run. */
export async function readHealth(pool: Pool, configHash: string, staleHours: number): Promise<Health> {
  const { rows } = await retryTransient(() =>
    pool.query(
      `SELECT now() AS checked_at,
              (SELECT max(finished_at) FROM crawl_runs WHERE status IN ('succeeded', 'partial')) AS last_success,
              (SELECT count(*)::int FROM canonical_jobs WHERE status = 'active') AS active_jobs,
              (SELECT count(*)::int FROM job_sources
                WHERE enabled AND (last_complete_snapshot_at IS NULL
                                   OR last_complete_snapshot_at < now() - make_interval(hours => $1))) AS stale_sources`,
      [staleHours],
    ),
  );
  const facts = rows[0];
  const latest = async (table: string) => {
    const { rows: runs } = await pool.query(`SELECT status, finished_at FROM ${table} ORDER BY id DESC LIMIT 1`);
    return runs[0] ? { status: runs[0].status as string, finishedAt: runs[0].finished_at as Date | null } : null;
  };
  const lastSuccessfulCrawl: Date | null = facts.last_success;
  return {
    checkedAt: facts.checked_at,
    lastSuccessfulCrawl,
    lastCrawl: await latest("crawl_runs"),
    discoveryStale: isDiscoveryStale(lastSuccessfulCrawl, facts.checked_at, staleHours),
    staleSources: facts.stale_sources,
    activeJobs: facts.active_jobs,
    backlog: await readBacklogFor(pool, configHash),
    aiMinutesThisMonth: await readAiMinutesThisMonth(pool),
    outbox: await readOutbox(pool),
    lastNotify: await latest("notify_runs"),
  };
}

const when = (value: Date | null | undefined) => value?.toISOString() ?? "never";

/** Compact and free of job or profile text, because it lands in the Actions step summary. */
export function renderHealth(health: Health): string {
  const { backlog, outbox } = health;
  return [
    "### Job hunter health",
    "",
    "| Check | Value |",
    "| --- | --- |",
    `| Discovery | ${health.discoveryStale ? "**STALE**" : "fresh"} |`,
    `| Last successful crawl | ${when(health.lastSuccessfulCrawl)} |`,
    `| Latest crawl | ${health.lastCrawl?.status ?? "none"} |`,
    `| Sources without a recent complete snapshot | ${health.staleSources} |`,
    `| Active jobs | ${health.activeJobs} |`,
    `| AI backlog | ${backlog.pending} pending, ${backlog.due} due, oldest ${backlog.oldestAgeSeconds ?? 0} s, ${backlog.exhausted} exhausted |`,
    `| AI time this month | ${health.aiMinutesThisMonth} min |`,
    `| Outbox | ${outbox.pending ?? 0} pending, ${outbox.retry ?? 0} retrying, ${outbox.sent ?? 0} sent, ${outbox.suppressed ?? 0} suppressed |`,
    `| Needs a person | ${outbox.ambiguous ?? 0} ambiguous, ${outbox.failed ?? 0} failed |`,
    `| Latest delivery | ${health.lastNotify?.status ?? "none"} |`,
  ].join("\n");
}

/** Share of the monthly AI allowance at which the owner is warned. */
export const BUDGET_WARN_RATIO = 0.9;

/**
 * Conditions that need the owner, in plain words. Free of job and profile text
 * because the result is sent to a chat. Empty means nothing to report.
 */
export function healthAlerts(health: Health, aiMinutesPerMonth: number): string[] {
  const alerts: string[] = [];
  if (health.discoveryStale) alerts.push(`Discovery is stale. Last successful crawl: ${when(health.lastSuccessfulCrawl)}.`);
  if (health.lastCrawl?.status === "failed") alerts.push("The latest crawl failed.");
  if (aiMinutesPerMonth > 0 && health.aiMinutesThisMonth >= aiMinutesPerMonth * BUDGET_WARN_RATIO) {
    const spent = health.aiMinutesThisMonth >= aiMinutesPerMonth;
    alerts.push(
      `${spent ? "Monthly AI budget is spent" : "Monthly AI budget is nearly spent"}: ${health.aiMinutesThisMonth} of ${aiMinutesPerMonth} min.` +
        (spent ? " Matching waits for next month." : ""),
    );
  }
  const { ambiguous = 0, failed = 0 } = health.outbox;
  if (ambiguous > 0) alerts.push(`${ambiguous} alert(s) have unconfirmed delivery. Check the chat, then run notify --retry-ambiguous if missing.`);
  if (failed > 0) alerts.push(`${failed} alert(s) failed. Run notify --retry-failed once the cause is fixed.`);
  return alerts;
}

export function renderAlerts(alerts: string[]): string {
  return ["<b>Job hunter needs attention</b>", ...alerts.map((a) => `• ${a.replace(/&/g, "&amp;").replace(/</g, "&lt;")}`)].join("\n");
}
