import { z } from "zod";
import { htmlToText } from "../normalize/html";
import type { Connector, CrawlOutcome, CrawlPage, CrawlSource, RawListing } from "./types";
import type { HttpClient } from "../http/client";

const API_BASE = "https://api.ashbyhq.com/posting-api/job-board";

const AddressSchema = z
  .object({ postalAddress: z.object({ addressCountry: z.string().nullable().optional() }).nullable().optional() })
  .nullable()
  .optional();

const JobSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  jobUrl: z.string().url(),
  location: z.string().nullable().optional(),
  secondaryLocations: z.array(z.object({ location: z.string().nullable().optional(), address: AddressSchema })).optional(),
  address: AddressSchema,
  isListed: z.boolean().optional(),
  workplaceType: z.string().nullable().optional(),
  employmentType: z.string().nullable().optional(),
  publishedAt: z.string().nullable().optional(),
  descriptionHtml: z.string().nullable().optional(),
  descriptionPlain: z.string().nullable().optional(),
});

const BoardSchema = z.object({ jobs: z.array(z.unknown()) });

/** The spellings `detectWorkArrangement` trusts. */
const WORKPLACE: Record<string, string> = { OnSite: "on-site", Hybrid: "hybrid", Remote: "remote" };

const toDate = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

function toListing(job: z.infer<typeof JobSchema>): RawListing {
  const secondary = job.secondaryLocations ?? [];
  const countries = [job.address, ...secondary.map((place) => place.address)].map((address) => address?.postalAddress?.addressCountry);
  const originalDescription = job.descriptionHtml ?? "";
  return {
    providerJobId: job.id,
    requisitionId: null,
    title: job.title,
    originalDescription,
    descriptionText: job.descriptionPlain?.trim() || htmlToText(originalDescription),
    location: job.location ?? null,
    extraLocations: [...secondary.map((place) => place.location), ...countries].filter((value): value is string => !!value),
    workplaceType: job.workplaceType ? (WORKPLACE[job.workplaceType] ?? null) : null,
    // "PartTime" has to read as two words for the employment type rules.
    commitment: job.employmentType?.replace(/([a-z])([A-Z])/g, "$1 $2") ?? null,
    salary: null,
    applicationUrl: job.jobUrl,
    publishedAt: toDate(job.publishedAt),
    providerUpdatedAt: null,
  };
}

export const ashbyConnector: Connector = {
  provider: "ashby",
  /** The board endpoint has no pagination: one response is the whole snapshot. */
  async *crawl(source: CrawlSource, http: HttpClient): AsyncGenerator<CrawlPage, CrawlOutcome, void> {
    const url = `${API_BASE}/${encodeURIComponent(source.providerKey)}`;
    const result = await http.get(url, { etag: source.etag });
    if (result.kind === "not_modified") return { kind: "not_modified", pages: 1, httpStatus: 304 };
    if (result.kind === "blocked") return { kind: "blocked", pages: 0, reason: result.error, httpStatus: result.status };
    if (result.kind === "failed") return { kind: "failed", pages: 0, reason: result.error, httpStatus: result.status };

    let body: unknown;
    try {
      body = JSON.parse(result.body);
    } catch {
      return { kind: "failed", pages: 0, reason: "Response was not JSON", httpStatus: result.status };
    }
    const board = BoardSchema.safeParse(body);
    if (!board.success) return { kind: "failed", pages: 0, reason: "Unexpected board shape", httpStatus: result.status };

    const listings: RawListing[] = [];
    let invalidRecords = 0;
    for (const entry of board.data.jobs) {
      const job = JobSchema.safeParse(entry);
      if (!job.success) invalidRecords += 1;
      // An unlisted job is reachable by direct link only, so the company has not advertised it.
      else if (job.data.isListed !== false) listings.push(toListing(job.data));
    }
    yield { listings, invalidRecords };

    if (invalidRecords > 0) {
      return { kind: "partial", pages: 1, reason: `${invalidRecords} invalid records`, httpStatus: result.status };
    }
    return { kind: "complete", pages: 1, listings: listings.length, etag: result.etag, httpStatus: result.status };
  },
};
