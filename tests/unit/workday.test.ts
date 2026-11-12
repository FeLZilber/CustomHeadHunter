import { describe, expect, it } from "vitest";
import {
  WORKDAY_MAX_PAGES, WORKDAY_PAGE_SIZE, findIsraelFacet, parseWorkdayUrl, workdayConnector, workdayKey,
} from "../../src/connectors/workday";
import type { CrawlOutcome, CrawlPage, RawListing } from "../../src/connectors/types";
import { HttpClient, type Transport, type TransportResponse } from "../../src/http/client";

const KEY = "https://acme.wd5.myworkdayjobs.com/Careers";
const API = "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers";
const IL = "il-id";

const json = (body: unknown): TransportResponse => ({ status: 200, body: JSON.stringify(body), headers: {} });
const status = (code: number): TransportResponse => ({ status: code, body: "", headers: {} });

const COUNTRY_FACETS = [
  { facetParameter: "timeType", values: [{ descriptor: "Full time", id: "ft", count: 9 }] },
  {
    facetParameter: "locationMainGroup",
    values: [
      {
        facetParameter: "locationHierarchy1",
        descriptor: "Locations",
        values: [{ descriptor: "India", id: "in-id", count: 5 }, { descriptor: "Israel", id: IL, count: 2 }],
      },
      { facetParameter: "locations", descriptor: "Sites", values: [{ descriptor: "Israel, Tel Aviv", id: "tlv", count: 2 }] },
    ],
  },
];

const summary = (n: number) => ({ title: `Job ${n}`, externalPath: `/job/Israel-Tel-Aviv/Job-${n}_JR${n}`, locationsText: "Israel, Tel Aviv" });
const detail = (n: number, overrides: object = {}) => ({
  jobPostingInfo: {
    id: `wid-${n}`,
    title: `Job ${n}`,
    jobDescription: "<p>Write <b>Playwright</b> tests</p>",
    location: "Israel, Tel Aviv",
    additionalLocations: ["Israel, Yokneam"],
    startDate: "2026-11-01",
    timeType: "Full time",
    jobReqId: `JR${n}`,
    externalUrl: `https://acme.wd5.myworkdayjobs.com/Careers/job/Israel-Tel-Aviv/Job-${n}_JR${n}`,
    country: { descriptor: "Israel", id: IL },
    ...overrides,
  },
});

interface Call {
  url: string;
  method: string;
  body: { appliedFacets: Record<string, string[]>; limit: number; offset: number } | null;
}

function http(handler: (call: Call) => TransportResponse) {
  const calls: Call[] = [];
  const transport: Transport = async (url, _headers, options) => {
    const call: Call = { url: url.toString(), method: options.method ?? "GET", body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    return handler(call);
  };
  return { client: new HttpClient({ transport, sleep: async () => {}, random: () => 0, hostIntervalMs: {}, maxRetries: 0 }), calls };
}

/** A site with `count` Israeli jobs behind the country facet. */
function site(count: number, options: { facets?: unknown; detail?: (n: number) => TransportResponse; total?: number } = {}) {
  return http((call) => {
    if (call.method === "POST") {
      const filtered = Object.keys(call.body!.appliedFacets).length > 0;
      if (!filtered) return json({ total: 500, jobPostings: [summary(900)], facets: options.facets ?? COUNTRY_FACETS });
      const { offset } = call.body!;
      const rows = Array.from({ length: Math.max(0, Math.min(WORKDAY_PAGE_SIZE, count - offset)) }, (_, i) => summary(offset + i + 1));
      return json({ total: offset === 0 ? (options.total ?? count) : 0, jobPostings: rows });
    }
    const n = Number(/_JR(\d+)$/.exec(call.url)![1]);
    return options.detail ? options.detail(n) : json(detail(n));
  });
}

async function collect(client: HttpClient, providerKey = KEY) {
  const pages: CrawlPage[] = [];
  const generator = workdayConnector.crawl({ providerKey, etag: null }, client);
  let step = await generator.next();
  while (!step.done) {
    pages.push(step.value);
    step = await generator.next();
  }
  return { pages, outcome: step.value as CrawlOutcome, listings: pages.flatMap((page) => page.listings) as RawListing[] };
}

describe("parseWorkdayUrl", () => {
  it("reads the tenant and site from a careers or job link, with or without a locale", () => {
    const expected = { origin: "https://acme.wd5.myworkdayjobs.com", tenant: "acme", site: "Careers" };
    expect(parseWorkdayUrl(KEY)).toEqual(expected);
    expect(parseWorkdayUrl("https://ACME.wd5.myworkdayjobs.com/en-US/Careers/job/Israel/QA_JR1?source=x")).toEqual(expected);
    expect(workdayKey(expected)).toBe(KEY);
  });

  it("refuses other hosts, plain http and a link with no site", () => {
    for (const url of [
      "http://acme.wd5.myworkdayjobs.com/Careers",
      "https://acme.wd5.myworkdayjobs.com/",
      "https://acme.wd5.myworkdayjobs.com/en-US",
      "https://acme.wd5.myworkdayjobs.com.evil.com/Careers",
      "https://myworkdayjobs.com/Careers",
      "https://www.workday.com/en-us/company/careers.html",
      "not a url",
    ]) {
      expect(parseWorkdayUrl(url), url).toBeNull();
    }
  });
});

describe("findIsraelFacet", () => {
  it("prefers the country value over site values", () => {
    expect(findIsraelFacet(COUNTRY_FACETS)).toEqual({ choice: { parameter: "locationHierarchy1", ids: [IL] }, hasLocations: true });
  });

  it("uses every Israeli site when the tenant has no country level", () => {
    const facets = [{
      facetParameter: "locationMainGroup",
      values: [{
        facetParameter: "locations",
        values: [
          { descriptor: "Israel, Haifa", id: "a" }, { descriptor: "India, Bangalore", id: "b" }, { descriptor: "Israel, Petah Tikva", id: "c" },
        ],
      }],
    }];
    expect(findIsraelFacet(facets).choice).toEqual({ parameter: "locations", ids: ["a", "c"] });
  });

  it("tells a site with no Israeli job from a response it cannot read", () => {
    const abroad = [{ facetParameter: "locations", values: [{ descriptor: "India, Bangalore", id: "b" }] }];
    expect(findIsraelFacet(abroad)).toEqual({ choice: null, hasLocations: true });
    expect(findIsraelFacet([{ facetParameter: "timeType", values: [] }])).toEqual({ choice: null, hasLocations: false });
    expect(findIsraelFacet(undefined)).toEqual({ choice: null, hasLocations: false });
  });
});

describe("workday connector", () => {
  it("narrows the search to Israel and maps each posting from its detail", async () => {
    const { client, calls } = site(2);
    const { listings, outcome } = await collect(client);
    expect(outcome).toMatchObject({ kind: "complete", pages: 1, listings: 2, etag: null });
    expect(calls[0]).toMatchObject({ url: `${API}/jobs`, method: "POST", body: { appliedFacets: {}, offset: 0 } });
    expect(calls[1]).toMatchObject({ method: "POST", body: { appliedFacets: { locationHierarchy1: [IL] }, limit: WORKDAY_PAGE_SIZE, offset: 0 } });
    expect(calls[2]).toMatchObject({ url: `${API}/job/Israel-Tel-Aviv/Job-1_JR1`, method: "GET" });
    expect(listings[0]).toMatchObject({
      providerJobId: "wid-1",
      requisitionId: "JR1",
      title: "Job 1",
      descriptionText: "Write Playwright tests",
      location: "Israel, Tel Aviv",
      extraLocations: ["Israel, Yokneam", "Israel"],
      commitment: "Full time",
      applicationUrl: "https://acme.wd5.myworkdayjobs.com/Careers/job/Israel-Tel-Aviv/Job-1_JR1",
    });
    expect(listings[0]?.publishedAt?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("pages until the announced total, which only the first page reports", async () => {
    const { client, calls } = site(WORKDAY_PAGE_SIZE * 2);
    const { outcome, pages, listings } = await collect(client);
    expect(outcome).toMatchObject({ kind: "complete", pages: 2, listings: 40 });
    expect(pages).toHaveLength(2);
    expect(new Set(listings.map((l) => l.providerJobId)).size).toBe(40);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body!.offset)).toEqual([0, 0, 20]);
  });

  it("does not trust a link that points off the career site", async () => {
    const { client } = site(1, { detail: (n) => json(detail(n, { id: null, externalUrl: "https://evil.example/job" })) });
    const { listings } = await collect(client);
    expect(listings[0]).toMatchObject({
      providerJobId: "/job/Israel-Tel-Aviv/Job-1_JR1",
      applicationUrl: "https://acme.wd5.myworkdayjobs.com/Careers/job/Israel-Tel-Aviv/Job-1_JR1",
    });
  });

  it("reports an empty complete snapshot when the site lists no Israeli job", async () => {
    const facets = [{ facetParameter: "locations", values: [{ descriptor: "India, Bangalore", id: "b" }] }];
    expect((await collect(site(0, { facets }).client)).outcome).toMatchObject({ kind: "complete", listings: 0 });
  });

  it("fails rather than report an empty board when it cannot find a location facet", async () => {
    expect((await collect(site(3, { facets: [] }).client)).outcome).toMatchObject({ kind: "failed", reason: "No location facet found" });
  });

  it("is partial, never complete, when a detail fails or is malformed", async () => {
    const failing = await collect(site(3, { detail: (n) => (n === 2 ? status(500) : json(detail(n))) }).client);
    expect(failing.outcome.kind).toBe("partial");
    expect(failing.listings).toHaveLength(2);

    const malformed = await collect(site(3, { detail: (n) => (n === 2 ? json({ nope: true }) : json(detail(n))) }).client);
    expect(malformed.outcome).toMatchObject({ kind: "partial", reason: "1 invalid records" });
    expect(malformed.pages[0]?.invalidRecords).toBe(1);
  });

  it("is partial when fewer postings arrive than the site announced", async () => {
    expect((await collect(site(5, { total: 9 }).client)).outcome).toMatchObject({ kind: "partial", reason: "Listed 5 of 9 postings" });
  });

  it("stops at the page limit as partial", async () => {
    const { outcome, pages } = await collect(site(WORKDAY_PAGE_SIZE * (WORKDAY_MAX_PAGES + 2)).client);
    expect(outcome).toMatchObject({ kind: "partial", reason: "Page limit reached" });
    expect(pages).toHaveLength(WORKDAY_MAX_PAGES);
  });

  it("keeps earlier pages when a later search fails", async () => {
    const { client } = http((call) => {
      if (call.method === "GET") return json(detail(Number(/_JR(\d+)$/.exec(call.url)![1])));
      if (Object.keys(call.body!.appliedFacets).length === 0) return json({ total: 9, jobPostings: [], facets: COUNTRY_FACETS });
      if (call.body!.offset > 0) return status(500);
      return json({ total: 30, jobPostings: Array.from({ length: WORKDAY_PAGE_SIZE }, (_, i) => summary(i + 1)) });
    });
    const { outcome, listings } = await collect(client);
    expect(outcome.kind).toBe("partial");
    expect(listings).toHaveLength(WORKDAY_PAGE_SIZE);
  });

  it("reports blocking, failure and bad input without throwing", async () => {
    expect((await collect(http(() => status(403)).client)).outcome.kind).toBe("blocked");
    expect((await collect(http(() => status(404)).client)).outcome).toMatchObject({ kind: "failed", httpStatus: 404 });
    expect((await collect(http(() => ({ status: 200, body: "<html>", headers: {} })).client)).outcome.kind).toBe("failed");
    expect((await collect(http(() => status(200)).client, "https://example.com/careers")).outcome).toMatchObject({
      kind: "failed",
      reason: "Invalid Workday career site URL",
    });
  });
});
