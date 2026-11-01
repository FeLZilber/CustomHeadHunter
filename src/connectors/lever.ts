import { z } from "zod";
import { htmlToText } from "../normalize/html";
import type { Connector, CrawlOutcome, CrawlPage, CrawlSource, RawListing } from "./types";
import type { HttpClient } from "../http/client";

const API_BASE = "https://api.lever.co/v0/postings";
export const LEVER_PAGE_SIZE = 100;
export const LEVER_MAX_PAGES = 20;

const PostingSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  hostedUrl: z.string().url(),
  applyUrl: z.string().url().optional(),
  createdAt: z.number().optional(),
  country: z.string().nullable().optional(),
  workplaceType: z.string().nullable().optional(),
  categories: z
    .object({
      location: z.string().nullable().optional(),
      commitment: z.string().nullable().optional(),
      allLocations: z.array(z.string()).optional(),
    })
    .optional(),
  description: z.string().optional(),
  descriptionPlain: z.string().optional(),
  additional: z.string().optional(),
  additionalPlain: z.string().optional(),
  lists: z.array(z.object({ text: z.string().optional(), content: z.string().optional() })).optional(),
  salaryRange: z
    .object({
      currency: z.string().nullable().optional(),
      interval: z.string().nullable().optional(),
      min: z.number().nullable().optional(),
      max: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
});

type Posting = z.infer<typeof PostingSchema>;

function toListing(posting: Posting): RawListing {
  const sections = (posting.lists ?? []).map((list) => `\n${list.text ?? ""}\n${htmlToText(list.content ?? "")}`);
  const descriptionText = [
    posting.descriptionPlain?.trim() || htmlToText(posting.description ?? ""),
    ...sections,
    posting.additionalPlain?.trim() || htmlToText(posting.additional ?? ""),
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
  const originalDescription = [
    posting.description ?? "",
    ...(posting.lists ?? []).map((list) => `<h3>${list.text ?? ""}</h3><ul>${list.content ?? ""}</ul>`),
    posting.additional ?? "",
  ].join("\n");
  const salary = posting.salaryRange;
  return {
    providerJobId: posting.id,
    requisitionId: null,
    title: posting.text,
    originalDescription,
    descriptionText,
    location: posting.categories?.location ?? null,
    extraLocations: [
      ...(posting.categories?.allLocations ?? []),
      ...(posting.country === "IL" ? ["Israel"] : []),
    ],
    workplaceType: posting.workplaceType ?? null,
    commitment: posting.categories?.commitment ?? null,
    salary: salary
      ? {
          min: salary.min ?? null,
          max: salary.max ?? null,
          currency: salary.currency ?? null,
          period: salary.interval ?? null,
          basis: null,
        }
      : null,
    applicationUrl: posting.hostedUrl,
    publishedAt: posting.createdAt ? new Date(posting.createdAt) : null,
    providerUpdatedAt: null,
  };
}

export const leverConnector: Connector = {
  provider: "lever",
  async *crawl(source: CrawlSource, http: HttpClient): AsyncGenerator<CrawlPage, CrawlOutcome, void> {
    const seen = new Set<string>();
    let invalidTotal = 0;
    let singlePageEtag: string | null = null;
    let lastStatus = 0;

    for (let page = 0; page < LEVER_MAX_PAGES; page += 1) {
      const skip = page * LEVER_PAGE_SIZE;
      const url = `${API_BASE}/${encodeURIComponent(source.providerKey)}?mode=json&skip=${skip}&limit=${LEVER_PAGE_SIZE}`;
      // A stored ETag only exists for boards that fit one page, where it proves the whole board is unchanged.
      const result = await http.get(url, { etag: page === 0 ? source.etag : null });

      if (result.kind === "not_modified") {
        return page === 0
          ? { kind: "not_modified", pages: 1, httpStatus: 304 }
          : { kind: "partial", pages: page, reason: "Unexpected 304 on a later page", httpStatus: 304 };
      }
      if (result.kind !== "ok") {
        const reason = result.error;
        if (page > 0) return { kind: "partial", pages: page, reason, httpStatus: result.status };
        return { kind: result.kind, pages: 0, reason, httpStatus: result.status };
      }
      lastStatus = result.status;

      let body: unknown;
      try {
        body = JSON.parse(result.body);
      } catch {
        return page > 0
          ? { kind: "partial", pages: page, reason: "Response was not JSON", httpStatus: lastStatus }
          : { kind: "failed", pages: 0, reason: "Response was not JSON", httpStatus: lastStatus };
      }
      const entries = z.array(z.unknown()).safeParse(body);
      if (!entries.success) {
        return page > 0
          ? { kind: "partial", pages: page, reason: "Unexpected page shape", httpStatus: lastStatus }
          : { kind: "failed", pages: 0, reason: "Unexpected page shape", httpStatus: lastStatus };
      }

      const listings: RawListing[] = [];
      let invalidRecords = 0;
      for (const entry of entries.data) {
        const posting = PostingSchema.safeParse(entry);
        if (!posting.success) {
          invalidRecords += 1;
        } else if (!seen.has(posting.data.id)) {
          seen.add(posting.data.id);
          listings.push(toListing(posting.data));
        }
      }
      invalidTotal += invalidRecords;
      yield { listings, invalidRecords };

      if (entries.data.length < LEVER_PAGE_SIZE) {
        if (page === 0) singlePageEtag = result.etag;
        if (invalidTotal > 0) {
          return { kind: "partial", pages: page + 1, reason: `${invalidTotal} invalid records`, httpStatus: lastStatus };
        }
        return { kind: "complete", pages: page + 1, listings: seen.size, etag: singlePageEtag, httpStatus: lastStatus };
      }
    }
    return { kind: "partial", pages: LEVER_MAX_PAGES, reason: "Page limit reached", httpStatus: lastStatus };
  },
};
