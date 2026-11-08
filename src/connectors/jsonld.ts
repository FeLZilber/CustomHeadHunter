import { z } from "zod";
import { htmlToText } from "../normalize/html";
import type { HttpClient } from "../http/client";
import type { Connector, CrawlOutcome, CrawlPage, CrawlSource, RawListing, Salary } from "./types";

export const JSONLD_MAX_DETAIL_PAGES = 150;

const HTML_ACCEPT = "text/html,application/xhtml+xml";
const XML_ACCEPT = "application/xml,text/xml";
const MAX_WALK_DEPTH = 8;

const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const LD_TYPE = /\btype\s*=\s*(?:"\s*application\/ld\+json\s*"|'\s*application\/ld\+json\s*'|application\/ld\+json(?=[\s>/]|$))/i;

/** Raw contents of every ld+json script block, in document order. */
function ldBlocks(html: string): string[] {
  const blocks: string[] = [];
  for (const match of html.matchAll(SCRIPT_BLOCK)) {
    if (LD_TYPE.test(match[1] ?? "")) blocks.push(match[2] ?? "");
  }
  return blocks;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isJobPosting(node: Record<string, unknown>): boolean {
  const type = node["@type"];
  return type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
}

/** Collects JobPosting nodes from arrays, @graph and ItemList wrappers. */
function collectPostings(value: unknown, out: unknown[], depth = 0): void {
  if (depth > MAX_WALK_DEPTH) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectPostings(entry, out, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  if (isJobPosting(value)) {
    out.push(value);
    return;
  }
  collectPostings(value["@graph"], out, depth + 1);
  const items = value.itemListElement;
  if (Array.isArray(items)) {
    for (const element of items) {
      collectPostings(isRecord(element) && "item" in element ? element.item : element, out, depth + 1);
    }
  }
}

const text = z.string().trim().min(1);
const AddressSchema = z.union([
  text,
  z
    .object({
      addressLocality: z.string().nullish(),
      addressRegion: z.string().nullish(),
      addressCountry: z.union([z.string(), z.object({ name: z.string().nullish() }).passthrough()]).nullish(),
    })
    .passthrough(),
]);
const PlaceSchema = z.union([
  text,
  z.object({ address: AddressSchema.nullish(), name: z.string().nullish() }).passthrough(),
]);
const MoneyValue = z.union([z.number(), z.string()]);
const BaseSalarySchema = z
  .object({
    currency: z.string().nullish(),
    value: z
      .union([
        MoneyValue,
        z
          .object({
            minValue: MoneyValue.nullish(),
            maxValue: MoneyValue.nullish(),
            value: MoneyValue.nullish(),
            unitText: z.string().nullish(),
          })
          .passthrough(),
      ])
      .nullish(),
  })
  .passthrough();

const PostingSchema = z
  .object({
    title: text,
    description: z.string().nullish(),
    identifier: z
      .union([z.string(), z.number(), z.object({ value: z.union([z.string(), z.number()]).nullish() }).passthrough()])
      .nullish(),
    url: z.string().nullish(),
    jobLocation: z.union([PlaceSchema, z.array(PlaceSchema)]).nullish(),
    jobLocationType: z.union([z.string(), z.array(z.string())]).nullish(),
    employmentType: z.union([z.string(), z.array(z.string())]).nullish(),
    datePosted: z.string().nullish(),
    validThrough: z.string().nullish(),
    baseSalary: BaseSalarySchema.nullish(),
  })
  .passthrough();

type Posting = z.infer<typeof PostingSchema>;

const COUNTRIES: Record<string, string> = { IL: "Israel", ISR: "Israel" };
const countryName = (raw: string): string => COUNTRIES[raw.trim().toUpperCase()] ?? raw.trim();

function placeParts(place: z.infer<typeof PlaceSchema>): { locality: string | null; country: string | null; label: string | null } {
  if (typeof place === "string") return { locality: place, country: null, label: place };
  const address = place.address;
  if (typeof address === "string") return { locality: address, country: null, label: address };
  if (!address) {
    const name = place.name?.trim() || null;
    return { locality: name, country: null, label: name };
  }
  const locality = address.addressLocality?.trim() || address.addressRegion?.trim() || null;
  const rawCountry = address.addressCountry;
  const country = rawCountry ? countryName(typeof rawCountry === "string" ? rawCountry : (rawCountry.name ?? "")) || null : null;
  return { locality, country, label: [locality, country].filter(Boolean).join(", ") || null };
}

const toNumber = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

function toSalary(base: Posting["baseSalary"]): Salary | null {
  if (!base) return null;
  const value = base.value;
  let min: number | null = null;
  let max: number | null = null;
  let period: string | null = null;
  if (typeof value === "number" || typeof value === "string") {
    min = max = toNumber(value);
  } else if (value) {
    const single = toNumber(value.value);
    min = toNumber(value.minValue) ?? single;
    max = toNumber(value.maxValue) ?? single;
    period = value.unitText?.trim().toLowerCase() || null;
  }
  if (min === null && max === null) return null;
  return { min, max, currency: base.currency?.trim() || null, period, basis: null };
}

const asList = <T>(value: T | T[] | null | undefined): T[] =>
  value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];

const httpsUrl = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
};

type Mapped = { kind: "listing"; listing: RawListing } | { kind: "closed" } | { kind: "invalid" };

function mapPosting(node: unknown, pageUrl: string, now: number): Mapped {
  const parsed = PostingSchema.safeParse(node);
  if (!parsed.success) return { kind: "invalid" };
  const posting = parsed.data;

  const validThrough = posting.validThrough ? Date.parse(posting.validThrough) : Number.NaN;
  if (!Number.isNaN(validThrough) && validThrough < now) return { kind: "closed" };

  const postingUrl = httpsUrl(posting.url);
  const identifier = posting.identifier;
  const identifierValue =
    identifier === null || identifier === undefined ? null : typeof identifier === "object" ? identifier.value : identifier;
  // The title fallback is the weakest id: renaming a posting that has no identifier or URL makes it look like a new job.
  const providerJobId =
    (identifierValue !== null && identifierValue !== undefined && String(identifierValue).trim()) ||
    postingUrl ||
    `${pageUrl}#${posting.title}`;

  const places = asList(posting.jobLocation).map(placeParts);
  const labels = places.map((p) => p.label).filter((l): l is string => Boolean(l));
  const extras = new Set<string>();
  for (const place of places) {
    if (place.locality) extras.add(place.locality);
    if (place.country) extras.add(place.country);
  }
  const remote = asList(posting.jobLocationType).some((t) => t.toUpperCase() === "TELECOMMUTE");
  const employment = asList(posting.employmentType).map((t) => t.trim()).filter(Boolean);
  const published = posting.datePosted ? new Date(posting.datePosted) : null;
  const description = posting.description ?? "";

  return {
    kind: "listing",
    listing: {
      providerJobId,
      requisitionId: null,
      title: posting.title,
      originalDescription: description,
      descriptionText: htmlToText(description),
      location: labels[0] ?? null,
      extraLocations: [...extras],
      workplaceType: remote ? "remote" : null,
      commitment: employment.length > 0 ? employment.join(", ") : null,
      salary: toSalary(posting.baseSalary),
      applicationUrl: postingUrl ?? pageUrl,
      publishedAt: published && !Number.isNaN(published.getTime()) ? published : null,
      providerUpdatedAt: null,
    },
  };
}

/** Never throws. Returns the listings on one page, the unusable records, and how many nodes were JobPostings. */
export function extractPostings(html: string, pageUrl: string, now: number): { listings: RawListing[]; invalidRecords: number; found: number } {
  const listings: RawListing[] = [];
  let invalidRecords = 0;
  let found = 0;
  for (const block of ldBlocks(html)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.trim());
    } catch {
      invalidRecords += 1;
      continue;
    }
    const nodes: unknown[] = [];
    try {
      collectPostings(parsed, nodes);
    } catch {
      invalidRecords += 1;
      continue;
    }
    for (const node of nodes) {
      found += 1;
      let mapped: Mapped;
      try {
        mapped = mapPosting(node, pageUrl, now);
      } catch {
        mapped = { kind: "invalid" };
      }
      if (mapped.kind === "listing") listings.push(mapped.listing);
      else if (mapped.kind === "invalid") invalidRecords += 1;
    }
  }
  return { listings, invalidRecords, found };
}

function sitemapUrls(xml: string, sitemap: URL): string[] {
  const urls = new Set<string>();
  for (const match of xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/gi)) {
    const raw = (match[1] ?? "").replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, "").trim().replace(/&amp;/g, "&");
    try {
      const url = new URL(raw);
      if (url.protocol === "https:" && url.host === sitemap.host) {
        url.hash = "";
        urls.add(url.toString());
      }
    } catch {
      // Not a URL; ignore.
    }
  }
  return [...urls];
}

const failed = (reason: string, httpStatus: number | null, pages = 0): CrawlOutcome => ({ kind: "failed", pages, reason, httpStatus });

/**
 * Reads schema.org JobPosting JSON-LD from a careers page or a job sitemap (providerKey is the https URL).
 *
 * Opt-in per catalog entry. No ETag is stored: pages change on every request, so a 304 would not prove the board
 * is unchanged. A page with zero JobPostings is a failure, never a complete empty snapshot, so a site redesign
 * cannot expire every job.
 */
export const jsonldConnector: Connector = {
  provider: "jsonld",
  async *crawl(source: CrawlSource, http: HttpClient): AsyncGenerator<CrawlPage, CrawlOutcome, void> {
    let root: URL;
    try {
      root = new URL(source.providerKey);
      if (root.protocol !== "https:") throw new Error("not https");
    } catch {
      return failed("Invalid careers URL", null);
    }
    const now = Date.now();
    const isSitemap = root.pathname.toLowerCase().endsWith(".xml");
    const seen = new Set<string>();
    let found = 0;
    let invalidTotal = 0;
    let lastStatus = 0;

    try {
      const first = await http.get(root.toString(), { accept: isSitemap ? XML_ACCEPT : HTML_ACCEPT });
      if (first.kind === "not_modified") return failed("Unexpected 304 to an unconditional request", 304);
      if (first.kind !== "ok") return { kind: first.kind, pages: 0, reason: first.error, httpStatus: first.status };
      lastStatus = first.status;

      let targets = [root.toString()];
      let problem: string | null = null;
      if (isSitemap) {
        const all = sitemapUrls(first.body, root);
        if (all.length > JSONLD_MAX_DETAIL_PAGES) problem = "Detail page limit reached";
        targets = all.slice(0, JSONLD_MAX_DETAIL_PAGES);
      }

      let pages = 0;
      for (const url of targets) {
        let body = first.body;
        if (isSitemap) {
          const result = await http.get(url, { accept: HTML_ACCEPT });
          if (result.kind !== "ok") {
            problem ??= `Detail page failed: ${result.kind === "not_modified" ? "HTTP 304" : result.error}`;
            continue;
          }
          body = result.body;
          lastStatus = result.status;
        }
        pages += 1;
        const extracted = extractPostings(body, url, now);
        found += extracted.found;
        invalidTotal += extracted.invalidRecords;
        const listings = extracted.listings.filter((l) => !seen.has(l.providerJobId) && seen.add(l.providerJobId));
        yield { listings, invalidRecords: extracted.invalidRecords };
      }

      if (problem) return { kind: "partial", pages, reason: problem, httpStatus: lastStatus };
      if (found === 0 && invalidTotal === 0) return failed("No JobPosting found", lastStatus, pages);
      if (invalidTotal > 0) {
        return { kind: "partial", pages, reason: `${invalidTotal} invalid records`, httpStatus: lastStatus };
      }
      return { kind: "complete", pages, listings: seen.size, etag: null, httpStatus: lastStatus };
    } catch (error) {
      return failed(`Unexpected error: ${String(error)}`, lastStatus || null);
    }
  },
};
