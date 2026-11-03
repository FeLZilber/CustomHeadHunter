import Link from "next/link";
import { requireOwner } from "../../dashboard/auth";
import { dashboardPool } from "../../dashboard/db";
import { loadContext, NEAR_MISS_FLOOR, parseFilters, searchJobs } from "../../dashboard/queries";
import { JobList } from "../_components/job-list";

type Params = Promise<Record<string, string | string[] | undefined>>;

/** Jobs the model scored just under the alert threshold. They never reached Telegram, so this is where a borderline fit gets a second look. */
export default async function NearMissesPage({ searchParams }: { searchParams: Params }) {
  await requireOwner();
  const filters = parseFilters({ ...(await searchParams), status: "active", sort: "best" });
  const pool = dashboardPool();
  const context = await loadContext(pool);
  const { jobs, hasMore } = await searchJobs(pool, context, filters, "near");
  const threshold = context.profile.preferences.notificationThreshold;
  return (
    <>
      <h1>Near misses</h1>
      <p className="meta">
        <span>
          Scored {NEAR_MISS_FLOOR} to {threshold - 1}, under the alert threshold of {threshold}. Dismiss the ones that are clearly wrong.
        </span>
      </p>
      <JobList jobs={jobs} empty="No near misses right now." />
      <nav className="pager" aria-label="Pages">
        {filters.page > 1 ? <Link href={`?page=${filters.page - 1}`}>Previous</Link> : null}
        {hasMore ? <Link href={`?page=${filters.page + 1}`}>Next</Link> : null}
      </nav>
    </>
  );
}
