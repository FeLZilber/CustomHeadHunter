import { requireOwner } from "../../dashboard/auth";
import { dashboardPool } from "../../dashboard/db";
import { buildSearchLinks } from "../../dashboard/search-links";
import { ensureProfile } from "../../profile/store";

export default async function SearchPage() {
  await requireOwner();
  const { matching } = await ensureProfile(dashboardPool());
  return (
    <>
      <h1>Search elsewhere</h1>
      <p className="meta">Ready-made searches for the sites and company boards the worker does not crawl, limited to about the past month. Jobs found here are not tracked.</p>
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
