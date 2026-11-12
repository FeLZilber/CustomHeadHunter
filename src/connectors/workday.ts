// Workday career sites ({tenant}.wd{N}.myworkdayjobs.com/{site}) load their job search from a public JSON
// endpoint on the same host: POST /wday/cxs/{tenant}/{site}/jobs lists postings, GET /wday/cxs/{tenant}/{site}/job/...
// returns one posting with its description. No key or sign-in is involved. Each tenant publishes its own robots.txt,
// which HttpClient enforces per request; the four tenants read on 2026-11-12 allow the career site and disallow only
// /refreshFacet/ and internal sites. Shapes verified against live responses the same day.
//
// A tenant can list thousands of jobs worldwide, and each description is a separate request, so the search is
// narrowed to the tenant's Israel location facet before anything is read. The owner approved reading these sites
// on 2026-11-12; Workday's own site terms forbid scraping workday.com and do not name tenant career sites.
import { z } from "zod";
import { htmlToText } from "../normalize/html";
import type { HttpClient } from "../http/client";
import type { Connector, CrawlOutcome, CrawlPage, CrawlSource, RawListing } from "./types";

export const WORKDAY_PAGE_SIZE = 20;
/** 1000 Israeli postings on one career site. More than that ends the crawl as partial, which never expires a job. */
export const WORKDAY_MAX_PAGES = 50;
/** Descriptions are fetched a few at a time; HttpClient still spaces the requests per host. */
const DETAIL_CONCURRENCY = 4;

const HOST = /^([a-z0-9][a-z0-9-]*)\.wd\d+\.myworkdayjobs\.com$/;
const LOCALE = /^[a-z]{2}-[A-Z]{2}$/;
const SITE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export interface WorkdaySite {
  origin: string;
  tenant: string;
  site: string;
}

/** Reads the tenant and career site out of any link on a Workday career site, including a job link. */
export function parseWorkdayUrl(input: string): WorkdaySite | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const tenant = HOST.exec(url.hostname.toLowerCase())?.[1];
  if (!tenant) return null;
  const site = url.pathname.split("/").filter(Boolean).find((segment) => !LOCALE.test(segment));
  if (!site || !SITE.test(site)) return null;
  return { origin: `https://${url.hostname.toLowerCase()}`, tenant, site };
}

/** The catalog key of a Workday source: the career site's address without locale, path or query. */
export const workdayKey = ({ origin, site }: WorkdaySite): string => `${origin}/${site}`;

const apiBase = ({ origin, tenant, site }: WorkdaySite): string => `${origin}/wday/cxs/${tenant}/${site}`;

const text = z.string().nullable().optional();

const SummarySchema = z.object({ title: z.string().min(1), externalPath: z.string().regex(/^\/job\//) });

const SearchSchema = z.object({
  total: z.number().optional(),
  jobPostings: z.array(z.unknown()),
  facets: z.array(z.unknown()).optional(),
});

const DetailSchema = z.object({
  jobPostingInfo: z.object({
    id: text,
    title: z.string().min(1),
    jobDescription: text,
    location: text,
    additionalLocations: z.array(z.string()).nullable().optional(),
    startDate: text,
    timeType: text,
    remoteType: text,
    jobReqId: text,
    externalUrl: text,
    country: z.object({ descriptor: text }).nullable().optional(),
  }),
});

interface FacetChoice {
  parameter: string;
  ids: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ISRAEL = /(?<![\p{L}])israel(?![\p{L}])/iu;

/**
 * Finds the facet values that mean Israel. Tenants differ: some have a country level ("Israel"), some only
 * sites ("Israel, Haifa"). A value that is exactly the country wins; otherwise every site in one facet is used.
 * `hasLocations` tells a tenant with no Israeli jobs today (no such value) from a response with no location
 * facet at all, which is a shape this connector cannot read.
 */
export function findIsraelFacet(facets: unknown): { choice: FacetChoice | null; hasLocations: boolean } {
  const exact: FacetChoice[] = [];
  const partial = new Map<string, string[]>();
  let hasLocations = false;
  const walk = (node: unknown, depth: number): void => {
    if (!isRecord(node) || depth > 4) return;
    const parameter = typeof node.facetParameter === "string" ? node.facetParameter : null;
    const values = Array.isArray(node.values) ? node.values : [];
    if (parameter && /location|country/i.test(parameter)) hasLocations = true;
    for (const value of values) {
      if (!isRecord(value)) continue;
      if (Array.isArray(value.values)) {
        walk(value, depth + 1);
        continue;
      }
      const descriptor = typeof value.descriptor === "string" ? value.descriptor.trim() : "";
      if (!parameter || typeof value.id !== "string" || !ISRAEL.test(descriptor)) continue;
      if (/^israel$/i.test(descriptor)) exact.push({ parameter, ids: [value.id] });
      else partial.set(parameter, [...(partial.get(parameter) ?? []), value.id]);
    }
  };
  for (const facet of Array.isArray(facets) ? facets : []) walk(facet, 0);
  if (exact[0]) return { choice: exact[0], hasLocations };
  const [parameter, ids] = [...partial.entries()][0] ?? [];
  return { choice: parameter && ids ? { parameter, ids } : null, hasLocations };
}

const toDate = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

function toListing(detail: z.infer<typeof DetailSchema>, externalPath: string, site: WorkdaySite): RawListing {
  const info = detail.jobPostingInfo;
  const originalDescription = info.jobDescription ?? "";
  const requisition = info.jobReqId?.trim();
  const country = info.country?.descriptor?.trim();
  let applicationUrl = `${site.origin}/${site.site}${externalPath}`;
  if (info.externalUrl && parseWorkdayUrl(info.externalUrl)?.origin === site.origin) applicationUrl = info.externalUrl;
  return {
    // The path holds the title, so a renamed posting would look new; the posting id does not change.
    providerJobId: info.id?.trim() || externalPath,
    requisitionId: requisition ? requisition : null,
    title: info.title,
    originalDescription,
    descriptionText: htmlToText(originalDescription),
    location: info.location?.trim() || null,
    // The search was narrowed to Israel, so a posting whose first location is abroad still has an Israeli one.
    extraLocations: [...(info.additionalLocations ?? []), ...(country ? [country] : [])],
    workplaceType: info.remoteType?.trim() || null,
    commitment: info.timeType?.trim() || null,
    salary: null,
    applicationUrl,
    publishedAt: toDate(info.startDate),
    providerUpdatedAt: null,
  };
}

const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

export const workdayConnector: Connector = {
  provider: "workday",
  /** providerKey is the career site's https address, as `workdayKey` writes it. No ETag: the search is a POST. */
  async *crawl(source: CrawlSource, http: HttpClient): AsyncGenerator<CrawlPage, CrawlOutcome, void> {
    const site = parseWorkdayUrl(source.providerKey);
    if (!site) return { kind: "failed", pages: 0, reason: "Invalid Workday career site URL", httpStatus: null };
    const base = apiBase(site);
    let pages = 0;
    let lastStatus: number | null = null;

    const search = async (appliedFacets: Record<string, string[]>, offset: number) => {
      const result = await http.postJson(`${base}/jobs`, { appliedFacets, limit: WORKDAY_PAGE_SIZE, offset, searchText: "" });
      if (result.kind !== "ok") {
        const kind = result.kind === "blocked" ? ("blocked" as const) : ("failed" as const);
        const reason = result.kind === "not_modified" ? "Unexpected 304" : result.error;
        return { stop: { kind, pages, reason, httpStatus: result.status } satisfies CrawlOutcome };
      }
      lastStatus = result.status;
      const parsed = SearchSchema.safeParse(parseJson(result.body));
      if (!parsed.success) {
        return { stop: { kind: "failed" as const, pages, reason: "Unexpected search response", httpStatus: result.status } };
      }
      return { data: parsed.data };
    };

    const first = await search({}, 0);
    if (first.stop) return first.stop;
    const { choice, hasLocations } = findIsraelFacet(first.data.facets);
    if (!choice) {
      if (!hasLocations) return { kind: "failed", pages: 0, reason: "No location facet found", httpStatus: lastStatus };
      // A real answer: the site lists no Israeli job today. Reconciliation still guards against a mass disappearance.
      return { kind: "complete", pages: 1, listings: 0, etag: null, httpStatus: lastStatus ?? 200 };
    }

    const facets = { [choice.parameter]: choice.ids };
    const seen = new Set<string>();
    let total: number | null = null;
    let problem: string | null = null;
    let listed = 0;

    for (let page = 0; ; page += 1) {
      if (page >= WORKDAY_MAX_PAGES) {
        problem ??= "Page limit reached";
        break;
      }
      const result = await search(facets, page * WORKDAY_PAGE_SIZE);
      if (result.stop) {
        if (pages === 0) return result.stop;
        return { kind: "partial", pages, reason: result.stop.reason, httpStatus: result.stop.httpStatus };
      }
      // Only the first page reports the total; later pages answer 0.
      if (page === 0) total = result.data.total ?? null;

      let invalidRecords = 0;
      const summaries: Array<z.infer<typeof SummarySchema>> = [];
      for (const entry of result.data.jobPostings) {
        const summary = SummarySchema.safeParse(entry);
        if (!summary.success) invalidRecords += 1;
        else if (!seen.has(summary.data.externalPath)) {
          seen.add(summary.data.externalPath);
          summaries.push(summary.data);
        }
      }

      const listings: RawListing[] = [];
      for (let start = 0; start < summaries.length; start += DETAIL_CONCURRENCY) {
        const batch = summaries.slice(start, start + DETAIL_CONCURRENCY);
        const details = await Promise.all(batch.map((summary) => http.get(`${base}${summary.externalPath}`)));
        details.forEach((detail, index) => {
          const { externalPath } = batch[index]!;
          if (detail.kind !== "ok") {
            problem ??= `Job detail failed: ${detail.kind === "not_modified" ? "HTTP 304" : detail.error}`;
            return;
          }
          const parsed = DetailSchema.safeParse(parseJson(detail.body));
          if (parsed.success) listings.push(toListing(parsed.data, externalPath, site));
          else invalidRecords += 1;
        });
      }
      if (invalidRecords > 0) problem ??= `${invalidRecords} invalid records`;

      pages += 1;
      listed += result.data.jobPostings.length;
      yield { listings, invalidRecords };

      if (result.data.jobPostings.length < WORKDAY_PAGE_SIZE) break;
      if (total !== null && listed >= total) break;
    }

    if (problem) return { kind: "partial", pages, reason: problem, httpStatus: lastStatus };
    // Fewer rows than the site announced means postings moved between pages mid-crawl; not a full snapshot.
    if (total !== null && listed < total) {
      return { kind: "partial", pages, reason: `Listed ${listed} of ${total} postings`, httpStatus: lastStatus };
    }
    return { kind: "complete", pages, listings: seen.size, etag: null, httpStatus: lastStatus ?? 200 };
  },
};
