import { requireOwner } from "../../dashboard/auth";
import { dashboardPool } from "../../dashboard/db";
import { loadContext, parseFilters, readDismissals, searchJobs } from "../../dashboard/queries";
import { humanize } from "../_components/format";
import { JobList } from "../_components/job-list";

export default async function DismissedPage() {
  await requireOwner();
  const pool = dashboardPool();
  const context = await loadContext(pool);
  const [{ jobs }, summary] = await Promise.all([
    searchJobs(pool, context, parseFilters({ status: "all", sort: "latest" }), "dismissed"),
    readDismissals(pool, context.profile.profileId),
  ]);
  return (
    <>
      <h1>Dismissed jobs</h1>
      {summary.total > 0 ? (
        <p className="meta">
          <span>{summary.total} dismissed</span>
          {summary.byReason.map(({ reason, count }) => (
            <span key={reason}>
              {humanize(reason)}: {count}
            </span>
          ))}
          {summary.repeatCompanies.length ? (
            <span>Dismissed more than once: {summary.repeatCompanies.map((c) => `${c.company} (${c.count})`).join(", ")}</span>
          ) : null}
        </p>
      ) : null}
      <JobList jobs={jobs} empty="Nothing dismissed yet." />
    </>
  );
}
