import Link from "next/link";
import { requireOwner } from "../../dashboard/auth";
import { dashboardPool } from "../../dashboard/db";
import { loadContext, parseFilters, readRejections, searchJobs } from "../../dashboard/queries";
import { humanize } from "../_components/format";
import { JobList } from "../_components/job-list";

type Params = Promise<Record<string, string | string[] | undefined>>;

/** The rejection audit: what the rule filter removes, and why, so a wrong rejection can be caught and flagged. */
export default async function FilteredPage({ searchParams }: { searchParams: Params }) {
  await requireOwner();
  const params = await searchParams;
  const filters = parseFilters({ ...params, status: "active", sort: "latest" });
  const flaggedView = params.view === "flagged";
  const pool = dashboardPool();
  const context = await loadContext(pool);
  const [{ jobs, hasMore }, summary] = await Promise.all([
    searchJobs(pool, context, filters, flaggedView ? "flagged" : "filtered"),
    readRejections(pool, context),
  ]);
  const base = `?page=`;
  const paged = (page: number) =>
    `${base}${page}${filters.reason ? `&reason=${filters.reason}` : ""}${filters.tier ? `&tier=${filters.tier}` : ""}${flaggedView ? "&view=flagged" : ""}`;
  return (
    <>
      <h1>Filtered out</h1>
      <p className="meta">
        <span>{summary.total} active jobs were removed by the filter before any model ran.</span>
        <span>{summary.adjacent} of them are adjacent roles: shown here, never scored or alerted.</span>
        <span>Open one that looks wrong and press &ldquo;Should have matched&rdquo;.</span>
      </p>
      <p className="meta">
        <Link href="/filtered">All ({summary.total})</Link>
        <Link href="/filtered?tier=adjacent">Adjacent ({summary.adjacent})</Link>
        {summary.byReason.map(({ reason, count }) => (
          <Link key={reason} href={`/filtered?reason=${reason}`}>
            {humanize(reason)} ({count})
          </Link>
        ))}
        <Link href="/filtered?view=flagged">Flagged as missed ({summary.flagged})</Link>
      </p>
      {summary.flaggedByReason.length ? (
        <p className="meta">
          <span>Rules behind the jobs you flagged:</span>
          {summary.flaggedByReason.map(({ reason, count }) => (
            <span key={reason}>
              {humanize(reason)} ({count})
            </span>
          ))}
        </p>
      ) : null}
      <JobList jobs={jobs} empty={flaggedView ? "Nothing flagged yet." : "No filtered jobs for this view."} />
      <nav className="pager" aria-label="Pages">
        {filters.page > 1 ? <Link href={paged(filters.page - 1)}>Previous</Link> : null}
        {hasMore ? <Link href={paged(filters.page + 1)}>Next</Link> : null}
      </nav>
    </>
  );
}
