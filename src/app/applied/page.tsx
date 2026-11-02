import { requireOwner } from "../../dashboard/auth";
import { dashboardPool } from "../../dashboard/db";
import { loadContext, parseFilters, searchJobs } from "../../dashboard/queries";
import { JobList } from "../_components/job-list";

export default async function AppliedPage() {
  await requireOwner();
  const pool = dashboardPool();
  const { jobs } = await searchJobs(pool, await loadContext(pool), parseFilters({ status: "all", sort: "latest" }), "applied");
  return (
    <>
      <h1>Applied jobs</h1>
      <JobList jobs={jobs} empty="No applications marked yet." />
    </>
  );
}
