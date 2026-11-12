import type { HttpClient } from "../http/client";

export type Provider = "greenhouse" | "lever" | "ashby" | "workable" | "jsonld" | "workday";

export interface Salary {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: string | null;
  basis: "gross" | "net" | null;
}

/** Provider data before normalization. Connectors do not interpret meaning. */
export interface RawListing {
  providerJobId: string;
  requisitionId: string | null;
  title: string;
  originalDescription: string;
  descriptionText: string;
  location: string | null;
  extraLocations: string[];
  workplaceType: string | null;
  commitment: string | null;
  salary: Salary | null;
  applicationUrl: string;
  publishedAt: Date | null;
  providerUpdatedAt: Date | null;
}

export interface CrawlSource {
  providerKey: string;
  etag: string | null;
}

export interface CrawlPage {
  listings: RawListing[];
  invalidRecords: number;
}

export type CrawlOutcome =
  | { kind: "complete"; pages: number; listings: number; etag: string | null; httpStatus: number }
  | { kind: "not_modified"; pages: number; httpStatus: number }
  | { kind: "partial"; pages: number; reason: string; httpStatus: number | null }
  | { kind: "failed"; pages: number; reason: string; httpStatus: number | null }
  | { kind: "blocked"; pages: number; reason: string; httpStatus: number | null };

export interface Connector {
  readonly provider: Provider;
  /** Yields each page as it arrives so it can be committed before the next request. */
  crawl(source: CrawlSource, http: HttpClient): AsyncGenerator<CrawlPage, CrawlOutcome, void>;
}
