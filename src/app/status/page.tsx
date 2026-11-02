import { requireOwner } from "../../dashboard/auth";
import { dashboardPool } from "../../dashboard/db";
import { loadDashboardEnv } from "../../dashboard/env";
import { loadContext, readStatus } from "../../dashboard/queries";
import { formatDateTime, humanize } from "../_components/format";

const DEFERRED_STOPS = new Set(["job_cap", "time_budget"]);

export default async function StatusPage() {
  await requireOwner();
  const pool = dashboardPool();
  const { health, sourceProblems, deliveryProblems, latestMatch } = await readStatus(
    pool,
    await loadContext(pool),
    loadDashboardEnv().STALE_DISCOVERY_HOURS,
  );
  const { backlog, outbox } = health;
  return (
    <>
      <h1>Status</h1>
      {health.discoveryStale ? (
        <p className="notice notice-error" role="alert">Discovery is stale. Check the discovery workflow.</p>
      ) : null}
      <dl className="facts">
        <dt>Last successful crawl</dt>
        <dd>{formatDateTime(health.lastSuccessfulCrawl)}</dd>
        <dt>Latest crawl</dt>
        <dd>{health.lastCrawl ? humanize(health.lastCrawl.status) : "None"}</dd>
        <dt>Sources without a recent complete snapshot</dt>
        <dd>{health.staleSources}</dd>
        <dt>Active jobs</dt>
        <dd>{health.activeJobs}</dd>
        <dt>AI backlog</dt>
        <dd>
          {backlog.pending} pending, {backlog.exhausted} failed after all attempts
        </dd>
        <dt>Latest matching</dt>
        <dd>
          {latestMatch
            ? `${humanize(latestMatch.status)}, ${latestMatch.succeeded} matched, ${latestMatch.failed} failed, ${formatDateTime(latestMatch.finishedAt)}`
            : "None"}
        </dd>
        <dt>AI time this month</dt>
        <dd>{health.aiMinutesThisMonth} minutes</dd>
        <dt>Budget deferrals</dt>
        <dd>
          {latestMatch?.stopReason && DEFERRED_STOPS.has(latestMatch.stopReason)
            ? `Stopped at its ${latestMatch.stopReason === "job_cap" ? "job limit" : "time budget"}; ${backlog.pending} jobs wait for later runs`
            : "None in the latest run"}
        </dd>
        <dt>Notifications</dt>
        <dd>
          {outbox.pending ?? 0} pending, {outbox.retry ?? 0} retrying, {outbox.sent ?? 0} sent, {outbox.suppressed ?? 0} suppressed
        </dd>
        <dt>Latest delivery</dt>
        <dd>{health.lastNotify ? humanize(health.lastNotify.status) : "None"}</dd>
      </dl>

      <h2>Source failures</h2>
      {sourceProblems.length ? (
        <ul>
          {sourceProblems.map((source) => (
            <li key={`${source.provider}-${source.company}`}>
              <span dir="auto">{source.company}</span> ({source.provider}): {humanize(source.outcome)}, {formatDateTime(source.at)}
              {source.error ? `, ${source.error}` : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">No source failed its latest crawl.</p>
      )}

      <h2>Deliveries that need you</h2>
      {deliveryProblems.length ? (
        <>
          <p className="meta">
            For an ambiguous delivery, check the Telegram chat. If the message is missing, run discovery with Retry ambiguous.
          </p>
          <ul>
            {deliveryProblems.map((delivery) => (
              <li key={delivery.id}>
                <span className="badge badge-failed">{humanize(delivery.status)}</span>{" "}
                <span dir="auto">{delivery.title ?? `${delivery.kind} message`}</span>, {formatDateTime(delivery.updatedAt)}
                {delivery.error ? `, ${delivery.error}` : ""}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="empty">No ambiguous or failed deliveries.</p>
      )}
    </>
  );
}
