import type { JobSummary, MatchState } from "../../dashboard/queries";

const LABELS: Record<MatchState, string> = {
  current: "Current",
  pending: "Match pending",
  stale: "Out of date",
  filtered: "Filtered out",
  failed: "Match failed",
  not_evaluated: "Not evaluated",
};

/** The label travels with the score, so an old or missing result is never read as a current verdict. */
export function MatchBadge({ job }: { job: Pick<JobSummary, "matchState" | "score"> }) {
  const current = job.matchState === "current";
  return (
    <span className={`badge badge-${job.matchState}`}>
      {current && job.score !== null ? `${job.score}/100` : LABELS[job.matchState]}
      {!current && job.score !== null ? ` · was ${job.score}` : ""}
    </span>
  );
}
