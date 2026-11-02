import { z } from "zod";
import { decodeEntities, htmlToText } from "../normalize/html";
import type { Connector, CrawlOutcome, CrawlPage, CrawlSource, RawListing } from "./types";
import type { HttpClient } from "../http/client";

const API_BASE = "https://boards-api.greenhouse.io/v1/boards";

const JobSchema = z.object({
  id: z.number(),
  title: z.string().min(1),
  absolute_url: z.string().url(),
  location: z.object({ name: z.string().nullable().optional() }).nullable().optional(),
  content: z.string().nullable().optional(),
  requisition_id: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  first_published: z.string().nullable().optional(),
  offices: z.array(z.object({ name: z.string().nullable().optional(), location: z.string().nullable().optional() })).optional(),
});

const BoardSchema = z.object({
  jobs: z.array(z.unknown()),
  meta: z.object({ total: z.number() }).optional(),
});

const toDate = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

function toListing(job: z.infer<typeof JobSchema>): RawListing {
  // Greenhouse entity-encodes its HTML, so it is decoded once before tag removal.
  const originalDescription = job.content ?? "";
  const requisition = job.requisition_id?.trim();
  return {
    providerJobId: String(job.id),
    requisitionId: requisition ? requisition : null,
    title: job.title,
    originalDescription,
    descriptionText: htmlToText(decodeEntities(originalDescription)),
    location: job.location?.name ?? null,
    extraLocations: (job.offices ?? []).flatMap((office) => [office.name, office.location].filter((v): v is string => !!v)),
    workplaceType: null,
    commitment: null,
    salary: null,
    applicationUrl: job.absolute_url,
    publishedAt: toDate(job.first_published),
    providerUpdatedAt: toDate(job.updated_at),
  };
}

export const greenhouseConnector: Connector = {
  provider: "greenhouse",
  /** The board endpoint has no pagination: one response is the whole snapshot. */
  async *crawl(source: CrawlSource, http: HttpClient): AsyncGenerator<CrawlPage, CrawlOutcome, void> {
    const url = `${API_BASE}/${encodeURIComponent(source.providerKey)}/jobs?content=true`;
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
    const total = board.data.meta?.total;
    if (total !== undefined && total !== board.data.jobs.length) {
      return { kind: "partial", pages: 1, reason: `meta.total ${total} != ${board.data.jobs.length}`, httpStatus: result.status };
    }
    return { kind: "complete", pages: 1, listings: listings.length, etag: result.etag, httpStatus: result.status };
  },
};
