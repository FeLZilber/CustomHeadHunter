import { ashbyConnector } from "../connectors/ashby";
import { greenhouseConnector } from "../connectors/greenhouse";
import { jsonldConnector } from "../connectors/jsonld";
import { leverConnector } from "../connectors/lever";
import { workableConnector } from "../connectors/workable";
import type { Connector, Provider, RawListing } from "../connectors/types";
import type { HttpClient } from "../http/client";
import { isInIsraelScope, normalizeLocation } from "../normalize/location";

/** Providers whose board slug can be guessed from a company name. jsonld is excluded: its key is a URL. */
export const PROVIDERS: Provider[] = ["greenhouse", "lever", "ashby", "workable"];

const CONNECTORS: Record<Provider, Connector> = {
  greenhouse: greenhouseConnector,
  lever: leverConnector,
  ashby: ashbyConnector,
  workable: workableConnector,
  jsonld: jsonldConnector,
};

/** Where a provider's public listing endpoint lives, recorded as the catalog's verification source. */
export const verificationUrl = (provider: Provider, key: string): string => {
  if (provider === "jsonld") return key;
  const k = encodeURIComponent(key);
  if (provider === "greenhouse") return `https://boards-api.greenhouse.io/v1/boards/${k}/jobs`;
  if (provider === "lever") return `https://api.lever.co/v0/postings/${k}`;
  if (provider === "workable") return `https://apply.workable.com/api/v1/widget/accounts/${k}?details=true`;
  return `https://api.ashbyhq.com/posting-api/job-board/${k}`;
};

export interface ProbeResult {
  provider: Provider;
  providerKey: string;
  /** "found" means the board exists and answered; it can still have zero Israeli jobs. */
  status: "found" | "missing" | "error";
  total: number;
  /** In Israel scope as the crawler sees it, which includes remote jobs open to Israel. */
  israeli: number;
  /** Located at a named Israeli place. The catalog bar: a remote-anywhere job does not make an Israeli employer. */
  israeliNamed: number;
  qaTitles: number;
  detail?: string;
}

const QA_HINT = /(?<![\p{L}\d])(qa|qe|sdet|quality|test(?:er|ing)?|automation)(?![\p{L}\d])|בדיק/iu;

export function countListings(listings: RawListing[]): Pick<ProbeResult, "total" | "israeli" | "israeliNamed" | "qaTitles"> {
  const located = listings.map((l) => ({ listing: l, where: normalizeLocation([l.location, ...l.extraLocations]) }));
  const israeliJobs = located.filter(({ where }) => isInIsraelScope(where)).map(({ listing }) => listing);
  return {
    total: listings.length,
    israeli: israeliJobs.length,
    israeliNamed: located.filter(({ where }) => where.places.length > 0).length,
    qaTitles: israeliJobs.filter((l) => QA_HINT.test(l.title)).length,
  };
}

/** Fetches one public board and counts what it holds. Never writes anything. */
export async function probeBoard(http: HttpClient, provider: Provider, providerKey: string): Promise<ProbeResult> {
  const listings: RawListing[] = [];
  const generator = CONNECTORS[provider].crawl({ providerKey, etag: null }, http);
  let step = await generator.next();
  while (!step.done) {
    listings.push(...step.value.listings);
    step = await generator.next();
  }
  const outcome = step.value;
  const base = { provider, providerKey };
  if (outcome.kind === "complete") return { ...base, status: "found", ...countListings(listings) };
  const missing = outcome.httpStatus === 404;
  return {
    ...base,
    status: missing ? "missing" : "error",
    total: 0,
    israeli: 0,
    israeliNamed: 0,
    qaTitles: 0,
    detail: "reason" in outcome ? outcome.reason : outcome.kind,
  };
}

/** Likely board slugs for a company name: "Check Point" -> checkpoint, check-point, check_point. */
export function slugCandidates(name: string): string[] {
  const words = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/[\s-]+/)
    .filter(Boolean);
  if (words.length === 0) return [];
  return [...new Set([words.join(""), words.join("-"), words.join("_")])];
}

/** Tries every provider and slug guess; returns boards that exist, best (most Israeli jobs) first. */
export async function discoverBoards(http: HttpClient, name: string, providers: Provider[] = PROVIDERS): Promise<ProbeResult[]> {
  const found: ProbeResult[] = [];
  for (const key of slugCandidates(name)) {
    for (const provider of providers) {
      const result = await probeBoard(http, provider, key);
      if (result.status === "found") found.push(result);
    }
  }
  return found.sort((a, b) => b.israeliNamed - a.israeliNamed || b.israeli - a.israeli || b.total - a.total);
}
