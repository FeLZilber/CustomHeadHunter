import { requireOwner } from "../../dashboard/auth";
import { dashboardPool } from "../../dashboard/db";
import { readSourceRequests } from "../../dashboard/queries";
import { buildSearchLinks } from "../../dashboard/search-links";
import { ensureProfile } from "../../profile/store";
import { followCompany } from "../actions";
import { humanize } from "../_components/format";

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ follow?: string }> }) {
  await requireOwner();
  const { follow } = await searchParams;
  const pool = dashboardPool();
  const [{ matching }, requests] = await Promise.all([ensureProfile(pool), readSourceRequests(pool)]);
  return (
    <>
      <h1>Search elsewhere</h1>
      <p className="meta">Ready-made searches for the sites and company boards the worker does not crawl, limited to about the past month. Found a company worth following? Paste a job or careers link from its Greenhouse, Lever or Ashby board below, and the daily run will track its Israeli jobs.</p>
      <section>
        <h2>Follow a company</h2>
        <form action={followCompany} className="profile" aria-label="Follow a company">
          <label>
            Job or careers link
            <input name="url" type="url" required placeholder="https://boards.greenhouse.io/company/jobs/123" />
          </label>
          <label>
            Company name (optional)
            <input name="company" maxLength={80} />
          </label>
          <button type="submit" className="button">Follow</button>
        </form>
        {follow === "requested" ? <p role="status">Requested. The next run checks the board and adds it if it lists Israeli jobs.</p> : null}
        {follow === "unsupported" ? <p role="alert">Only Greenhouse, Lever, Ashby and Workable links can be followed.</p> : null}
        {requests.length ? (
          <ul>
            {requests.map((request) => (
              <li key={`${request.provider}:${request.providerKey}`}>
                {request.companyName} ({humanize(request.provider)}): {humanize(request.status)}
                {request.detail ? `. ${request.detail}` : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      {buildSearchLinks(matching.titles).map((group) => (
        <section key={group.heading}>
          <h2>{group.heading}</h2>
          <ul>
            {group.links.map((link) => (
              <li key={link.label}>
                <a href={link.url} target="_blank" rel="noopener noreferrer nofollow">
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
