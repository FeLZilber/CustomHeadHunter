import Link from "next/link";
import type { JobSummary } from "../../dashboard/queries";
import { formatAgo, formatDate, humanize } from "./format";
import { DismissButton } from "./dismiss-button";
import { MissedButton } from "./missed-button";
import { MatchBadge } from "./match-badge";
import { SaveButton } from "./save-button";

function When({ label, value }: { label: string; value: Date }) {
  return (
    <span title={formatDate(value)}>
      {label} <time dateTime={value.toISOString()}>{formatAgo(value)}</time>
    </span>
  );
}

export function JobList({ jobs, empty, children }: { jobs: JobSummary[]; empty: string; children?: React.ReactNode }) {
  if (jobs.length === 0) {
    return (
      <div className="empty-state">
        <p className="empty">{empty}</p>
        {children}
      </div>
    );
  }
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
              {job.postedAt ? <When label="Posted" value={job.postedAt} /> : null}
              <When label="Found" value={job.discoveredAt} />
              {job.appliedAt ? <span className="badge badge-applied">Applied {formatDate(job.appliedAt)}</span> : null}
              {job.status === "expired" ? <span className="badge badge-expired">Expired</span> : null}
            </p>
            {job.matchState === "filtered" && job.reasonCodes.length ? (
              <p className="meta">
                {job.tier === "adjacent" ? <span className="badge badge-adjacent">Adjacent</span> : null}
                <span>Filtered: {job.reasonCodes.map(humanize).join(", ")}</span>
              </p>
            ) : null}
            {job.technologies.length ? <p className="tags">{job.technologies.slice(0, 8).join(" · ")}</p> : null}
          </div>
          <div className="job-side">
            <MatchBadge job={job} />
            <SaveButton jobId={job.id} saved={job.saved} />
            <DismissButton jobId={job.id} reason={job.dismissedReason} />
            {job.matchState === "filtered" ? <MissedButton jobId={job.id} flagged={job.flaggedMissed} /> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
