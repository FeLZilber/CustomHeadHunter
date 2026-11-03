import { notFound } from "next/navigation";
import { requireOwner } from "../../../dashboard/auth";
import { dashboardPool } from "../../../dashboard/db";
import { getJob, loadContext } from "../../../dashboard/queries";
import { formatDate, formatDateTime, humanize, safeHref } from "../../_components/format";
import { ApplyButton } from "../../_components/apply-button";
import { DismissButton } from "../../_components/dismiss-button";
import { MatchBadge } from "../../_components/match-badge";
import { SaveButton } from "../../_components/save-button";

const NOTICES: Record<string, string> = {
  pending: "This job is waiting for the model. Any score shown is from an earlier version of the job or profile.",
  stale: "The job, profile or configuration changed after this result, so it is shown for reference only.",
  failed: "The model could not produce a valid result for this job after its allowed attempts.",
  filtered: "The rule filter removed this job before matching, so no model ran.",
  not_evaluated: "This job has not been evaluated yet.",
};

function Evidence({ quote, unverified }: { quote: string; unverified: Set<string> }) {
  const verified = !unverified.has(quote);
  return (
    <>
      <q dir="auto">{quote}</q> <span className={verified ? "verified" : "unverified"}>{verified ? "Quote found in posting" : "Quote not found in posting"}</span>
    </>
  );
}

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  if (!/^\d{1,18}$/.test(id)) notFound();
  const pool = dashboardPool();
  const job = await getJob(pool, await loadContext(pool), id);
  if (!job) notFound();

  const href = safeHref(job.applicationUrl);
  const response = job.match?.response;
  const unverified = new Set(job.match?.unverified ?? []);
  return (
    <article className="detail">
      <h1 dir="auto">{job.title}</h1>
      <p className="meta">
        <span dir="auto">{job.company}</span>
        <span dir="auto">{job.location ?? "Location not stated"}</span>
        <span>{job.workArrangement ? humanize(job.workArrangement) : "Work arrangement not stated"}</span>
        <span>Found {formatDate(job.discoveredAt)}</span>
        <span>Last seen {formatDate(job.lastSeenAt)}</span>
        {job.status === "expired" ? <span className="badge badge-expired">Expired</span> : null}
      </p>
      <div className="actions">
        <MatchBadge job={job} />
        <SaveButton jobId={job.id} saved={job.saved} />
        <ApplyButton jobId={job.id} appliedAt={job.appliedAt} />
        <DismissButton jobId={job.id} reason={job.dismissedReason} />
        {href ? (
          <a className="button" href={href} target="_blank" rel="noopener noreferrer nofollow">
            Open original posting
          </a>
        ) : (
          <span className="unverified">No safe link for this posting</span>
        )}
      </div>

      {job.matchState !== "current" ? <p className="notice">{NOTICES[job.matchState]}</p> : null}
      {job.matchState === "filtered" && job.reasonCodes.length ? (
        <p className="meta">Reasons: {job.reasonCodes.map(humanize).join(", ")}</p>
      ) : null}

      {response && job.match ? (
        <section aria-labelledby="match-heading">
          <h2 id="match-heading">Match details</h2>
          <p dir="auto">{response.explanation}</p>
          <p className="meta">
            <span>Role: {humanize(response.role_category)}</span>
            <span>{job.recommendation ? humanize(job.recommendation) : null}</span>
            <span>
              {job.match.evidenceLiteral} of {job.match.evidenceTotal} quotes found in posting
            </span>
            {job.match.inputTruncated ? <span>Model saw a shortened posting</span> : null}
          </p>
          <h3>Requirements met</h3>
          {response.matching_requirements.length ? (
            <ul>
              {response.matching_requirements.map((finding) => (
                <li key={finding.requirement} dir="auto">
                  {finding.requirement}: <Evidence quote={finding.evidence} unverified={unverified} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">None reported.</p>
          )}
          <h3>Requirements missing</h3>
          {response.missing_requirements.length ? (
            <ul>
              {response.missing_requirements.map((finding) => (
                <li key={finding.requirement} dir="auto">
                  {finding.requirement}: <Evidence quote={finding.evidence} unverified={unverified} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">None reported.</p>
          )}
          <h3>Not stated in the profile</h3>
          {response.unknown_requirements.length ? (
            <ul>
              {response.unknown_requirements.map((finding) => (
                <li key={finding.requirement} dir="auto">
                  {finding.requirement}: {finding.reason}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">None reported.</p>
          )}
          {response.concerns.length ? (
            <>
              <h3>Concerns</h3>
              <ul>
                {response.concerns.map((concern) => (
                  <li key={concern} dir="auto">
                    {concern}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="meta">
            {job.match.model}, {job.match.promptVersion}, {formatDateTime(job.match.matchedAt)}
          </p>
        </section>
      ) : null}

      <section aria-labelledby="description-heading">
        <h2 id="description-heading">Description</h2>
        <p className="description" dir="auto">
          {job.description}
        </p>
      </section>

      <section aria-labelledby="history-heading">
        <h2 id="history-heading">History</h2>
        <ul>
          {job.events.map((event, index) => (
            <li key={index}>
              {humanize(event.type)}, {formatDateTime(event.at)}
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}
