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

export default async function JobsPage({ searchParams }: { searchParams: Params }) {
  await requireOwner();
  const filters = parseFilters(await searchParams);
  const pool = dashboardPool();
  const { jobs, hasMore } = await searchJobs(pool, await loadContext(pool), filters);
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
        <button type="submit" className="button">
          Search
        </button>
      </form>
      <JobList jobs={jobs} empty="No jobs match these filters." />
      <nav className="pager" aria-label="Pages">
        {filters.page > 1 ? <Link href={pageHref(filters, filters.page - 1)}>Previous</Link> : null}
        {hasMore ? <Link href={pageHref(filters, filters.page + 1)}>Next</Link> : null}
      </nav>
    </>
  );
}
