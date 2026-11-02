/** Sites the worker may not or cannot crawl. These links only open a search for the owner to run by hand. */
const HEBREW_TERMS = ["בודק תוכנה", "מהנדס אוטומציה", "QA אוטומציה"];

/** Google ignores words past 32, so a long profile must not cut the location off. */
const MAX_TERMS = 8;

const AREA = "(Israel OR ישראל)";

const JOB_SITES: Array<[string, string]> = [
  ["LinkedIn Jobs", "linkedin.com/jobs"],
  ["Indeed Israel", "il.indeed.com"],
  ["Glassdoor", "glassdoor.com"],
  ["AllJobs", "alljobs.co.il"],
  ["Drushim", "drushim.co.il"],
  ["SecretHunter", "secrethunter.io"],
  ["Facebook groups", "facebook.com/groups"],
];

const ATS_SITES: Array<[string, string]> = [
  ["Comeet", "comeet.com/jobs"],
  ["Greenhouse", "greenhouse.io"],
  ["Lever", "jobs.lever.co"],
  ["Ashby", "jobs.ashbyhq.com"],
  ["Workable", "apply.workable.com"],
  ["SmartRecruiters", "jobs.smartrecruiters.com"],
  ["Workday", "myworkdayjobs.com"],
  ["Breezy", "breezy.hr"],
];

export interface SearchLink {
  label: string;
  url: string;
}

export interface SearchGroup {
  heading: string;
  links: SearchLink[];
}

const quoted = (term: string) => `"${term.replace(/"/g, "")}"`;

/** Past month, matching the 30-day rule for postings worth applying to. */
const googleUrl = (query: string) => `https://www.google.com/search?${new URLSearchParams({ q: query, tbs: "qdr:m" })}`;

export function buildSearchLinks(titles: string[]): SearchGroup[] {
  const terms = [...new Set([...HEBREW_TERMS, ...titles])].slice(0, MAX_TERMS);
  const anyTerm = `(${terms.map(quoted).join(" OR ")})`;
  const onSite = ([label, site]: [string, string]): SearchLink => ({ label, url: googleUrl(`site:${site} ${anyTerm} ${AREA}`) });
  const linkedIn = new URLSearchParams({ keywords: titles[0] ?? "QA Automation", location: "Israel", f_TPR: "r2592000" });
  return [
    {
      heading: "Job sites",
      links: [{ label: "LinkedIn, direct search", url: `https://www.linkedin.com/jobs/search/?${linkedIn}` }, ...JOB_SITES.map(onSite)],
    },
    { heading: "Company career systems", links: ATS_SITES.map(onSite) },
    {
      heading: "Staffing agencies",
      links: [{ label: "Agencies hiring for these roles", url: googleUrl(`("חברת השמה" OR "recruitment agency") ${anyTerm} ${AREA}`) }],
    },
  ];
}
