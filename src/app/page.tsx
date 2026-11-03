import Link from "next/link";
import { requireOwner } from "../dashboard/auth";
import { dashboardPool } from "../dashboard/db";
import { loadContext, parseFilters, searchJobs, type JobFilters } from "../dashboard/queries";
import { JobList } from "./_components/job-list";

type Params = Promise<Record<string, string | string[] | undefined>>;

function pageHref(filters: JobFilters, page: number) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, page })) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  return `/?${query}`;
}

const MATCH_LABELS: Record<string, string> = { current: "Current", pending: "Pending", stale: "Out of date", filtered: "Filtered out", failed: "Failed" };
const POSTED_LABELS: Record<string, string> = { "14": "Last 14 days", "30": "Last 30 days", "90": "Last 90 days" };

/** The filters in force, each as a link that removes just that one. */
function activeFilters(filters: JobFilters): Array<{ key: string; label: string; href: string }> {
  const chips: Array<{ key: string; label: string; value: string }> = [];
  if (filters.q) chips.push({ key: "q", label: "Title", value: filters.q });
  if (filters.company) chips.push({ key: "company", label: "Company", value: filters.company });
  if (filters.location) chips.push({ key: "location", label: "Location", value: filters.location });
  if (filters.technology) chips.push({ key: "technology", label: "Technology", value: filters.technology });
  if (filters.minScore !== undefined) chips.push({ key: "minScore", label: "Score", value: `${filters.minScore}+` });
  if (filters.status !== "active") chips.push({ key: "status", label: "Status", value: filters.status });
  if (filters.match !== "all") chips.push({ key: "match", label: "Match", value: MATCH_LABELS[filters.match] ?? filters.match });
  if (filters.posted !== "any") chips.push({ key: "posted", label: "Posted", value: POSTED_LABELS[filters.posted] ?? filters.posted });
  return chips.map(({ key, label, value }) => ({ key, label: `${label}: ${value}`, href: pageHref({ ...filters, [key]: undefined, page: 1 }, 1) }));
}

export const metadata = { title: "Jobs" };

export default async function JobsPage({ searchParams }: { searchParams: Params }) {
  await requireOwner();
  const filters = parseFilters(await searchParams);
  const pool = dashboardPool();
  const { jobs, hasMore } = await searchJobs(pool, await loadContext(pool), filters);
  const chips = activeFilters(filters);
  // Rarely-used filters stay tucked away unless one of them is doing something.
  const advancedActive = filters.technology !== undefined || filters.minScore !== undefined || filters.status !== "active" || filters.match !== "all";
  return (
    <>
      <h1>{filters.sort === "best" ? "Best current matches" : "Latest jobs"}</h1>
      <form className="filters" action="/" role="search">
        <label>
          Title
          <input name="q" defaultValue={filters.q} dir="auto" />
        </label>
        <label>
          Company
          <input name="company" defaultValue={filters.company} dir="auto" />
        </label>
        <label>
          Location
          <input name="location" defaultValue={filters.location} dir="auto" />
        </label>
        <label>
          Posted
          <select name="posted" defaultValue={filters.posted}>
            <option value="any">Any time</option>
            <option value="14">Last 14 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </select>
        </label>
        <label>
          Sort
          <select name="sort" defaultValue={filters.sort}>
            <option value="best">Best match</option>
            <option value="latest">Latest found</option>
            <option value="posted">Latest posted</option>
          </select>
        </label>
        <button type="submit" className="button button-primary">
          Search
        </button>
        <details className="more-filters" open={advancedActive}>
          <summary>More filters</summary>
          <div className="filters">
            <label>
              Technology
              <input name="technology" defaultValue={filters.technology} />
            </label>
            <label>
              Minimum score
              <input name="minScore" type="number" min={0} max={100} defaultValue={filters.minScore} />
            </label>
            <label>
              Status
              <select name="status" defaultValue={filters.status}>
                <option value="active">Active</option>
                <option value="expired">Expired</option>
                <option value="all">All</option>
              </select>
            </label>
            <label>
              Match
              <select name="match" defaultValue={filters.match}>
                <option value="all">All</option>
                <option value="current">Current</option>
                <option value="pending">Pending</option>
                <option value="stale">Out of date</option>
                <option value="filtered">Filtered out</option>
                <option value="failed">Failed</option>
              </select>
            </label>
          </div>
        </details>
      </form>
      {chips.length ? (
        <p className="chips" aria-label="Active filters">
          {chips.map((chip) => (
            <Link key={chip.key} href={chip.href} className="chip" dir="auto">
              <span className="sr-only">Remove filter </span>
              {chip.label} <span aria-hidden="true">×</span>
            </Link>
          ))}
          <Link href="/" className="chip-clear">
            Clear all
          </Link>
        </p>
      ) : null}
      <JobList jobs={jobs} empty="No jobs match these filters.">
        {chips.length ? <Link href="/">Clear all filters</Link> : null}
      </JobList>
      {filters.page > 1 || hasMore ? (
        <nav className="pager" aria-label="Pages">
          {filters.page > 1 ? <Link href={pageHref(filters, filters.page - 1)}>← Previous</Link> : <span />}
          <span className="meta">Page {filters.page}</span>
          {hasMore ? <Link href={pageHref(filters, filters.page + 1)}>Next →</Link> : <span />}
        </nav>
      ) : null}
    </>
  );
}
