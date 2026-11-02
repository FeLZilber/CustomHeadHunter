import Link from "next/link";
import type { JobSummary } from "../../dashboard/queries";
import { formatDate } from "./format";
import { MatchBadge } from "./match-badge";
import { SaveButton } from "./save-button";

export function JobList({ jobs, empty }: { jobs: JobSummary[]; empty: string }) {
  if (jobs.length === 0) return <p className="empty">{empty}</p>;
  return (
    <ul className="jobs">
      {jobs.map((job) => (
        <li key={job.id} className="job">
          <div className="job-main">
            <h2>
              <Link href={`/jobs/${job.id}`} dir="auto">
                {job.title}
              </Link>
            </h2>
            <p className="meta">
              <span dir="auto">{job.company}</span>
              <span dir="auto">{job.location ?? "Location not stated"}</span>
              {job.postedAt ? <span>Posted {formatDate(job.postedAt)}</span> : null}
              <span>Found {formatDate(job.discoveredAt)}</span>
              {job.appliedAt ? <span className="badge badge-applied">Applied {formatDate(job.appliedAt)}</span> : null}
              {job.status === "expired" ? <span className="badge badge-expired">Expired</span> : null}
            </p>
            {job.technologies.length ? <p className="tags">{job.technologies.slice(0, 8).join(" · ")}</p> : null}
          </div>
          <div className="job-side">
            <MatchBadge job={job} />
            <SaveButton jobId={job.id} saved={job.saved} />
          </div>
        </li>
      ))}
    </ul>
  );
}
