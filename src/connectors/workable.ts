// Workable's public endpoint for an account's published jobs. Workable documents it as
// `https://www.workable.com/api/accounts/{subdomain}?details=true` ("Using the Workable API to create a
// careers page", https://help.workable.com/hc/en-us/articles/115012771647). That URL answers with a 302 to
// apply.workable.com/api/v1/widget/accounts/{subdomain}?details=true, which is called directly here to save
// a hop; apply.workable.com/robots.txt allows it (checked 2026-11-08, it also signals ai-train=no, and job
// text is never used for training). Shape verified against a live response.
import { z } from "zod";
import { htmlToText } from "../normalize/html";
import type { Connector, CrawlOutcome, CrawlPage, CrawlSource, RawListing } from "./types";
import type { HttpClient } from "../http/client";

const API_BASE = "https://apply.workable.com/api/v1/widget/accounts";

const text = z.string().nullable().optional();

const JobSchema = z
  .object({
    title: z.string().min(1),
    shortcode: z.string().min(1),
    employment_type: text,
    telecommuting: z.boolean().nullable().optional(),
    url: z.string().url().nullable().optional(),
    shortlink: z.string().url().nullable().optional(),
    published_on: text,
    country: text,
    city: text,
    locations: z.array(z.object({ country: text, countryCode: text, city: text })).nullable().optional(),
    description: text,
  })
  .refine((job) => !!(job.url || job.shortlink), { message: "no job link" });

const BoardSchema = z.object({ jobs: z.array(z.unknown()) });

const toDate = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

function toListing(job: z.infer<typeof JobSchema>): RawListing {
  const places = job.locations ?? [];
  const first = places[0];
  const city = first?.city || job.city;
  const country = first?.country || job.country;
  const location = [city, country].filter(Boolean).join(", ") || null;
  const extra = places.flatMap((place) => [place.country, place.city]);
  if (places.some((place) => place.countryCode?.toUpperCase() === "IL")) extra.push("Israel");
  const originalDescription = job.description ?? "";
  return {
    providerJobId: job.shortcode,
    requisitionId: null,
    title: job.title,
    originalDescription,
    descriptionText: htmlToText(originalDescription),
    location,
    extraLocations: extra.filter((value): value is string => !!value),
    workplaceType: job.telecommuting ? "remote" : null,
    commitment: job.employment_type || null,
    salary: null,
    applicationUrl: (job.url || job.shortlink)!,
    publishedAt: toDate(job.published_on),
    providerUpdatedAt: null,
  };
}

export const workableConnector: Connector = {
  provider: "workable",
  /** The widget endpoint has no pagination: one response is the whole snapshot. */
  async *crawl(source: CrawlSource, http: HttpClient): AsyncGenerator<CrawlPage, CrawlOutcome, void> {
    const url = `${API_BASE}/${encodeURIComponent(source.providerKey)}?details=true`;
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
      if (job.success) listings.push(toListing(job.data));
      else invalidRecords += 1;
    }
    yield { listings, invalidRecords };

    if (invalidRecords > 0) {
      return { kind: "partial", pages: 1, reason: `${invalidRecords} invalid records`, httpStatus: result.status };
    }
    return { kind: "complete", pages: 1, listings: listings.length, etag: result.etag, httpStatus: result.status };
  },
};
