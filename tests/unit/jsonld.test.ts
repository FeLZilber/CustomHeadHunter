import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JSONLD_MAX_DETAIL_PAGES, jsonldConnector } from "../../src/connectors/jsonld";
import type { CrawlOutcome, CrawlPage, RawListing } from "../../src/connectors/types";
import { HttpClient, type Transport, type TransportResponse } from "../../src/http/client";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/jsonld/${name}`, import.meta.url), "utf8");
const ok = (body: string): TransportResponse => ({ status: 200, body, headers: {} });
const status = (code: number): TransportResponse => ({ status: code, body: "", headers: {} });

function http(handler: (url: URL, headers: Record<string, string>) => TransportResponse) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const transport: Transport = async (url, headers) => {
    seen.push({ url: url.toString(), headers });
    return handler(url, headers);
  };
  return {
    client: new HttpClient({ transport, sleep: async () => {}, random: () => 0, hostIntervalMs: {}, maxRetries: 0 }),
    seen,
  };
}

async function run(providerKey: string, client: HttpClient, etag: string | null = null) {
  const pages: CrawlPage[] = [];
  const generator = jsonldConnector.crawl({ providerKey, etag }, client);
  let step = await generator.next();
  while (!step.done) {
    pages.push(step.value);
    step = await generator.next();
  }
  return { pages, outcome: step.value as CrawlOutcome, listings: pages.flatMap((p) => p.listings) as RawListing[] };
}

const PAGE = "https://acme.test/careers";
const page = (name: string) => http(() => ok(fixture(name)));

describe("jsonld connector, page mode", () => {
  it("reads a @graph posting and a standalone posting", async () => {
    const { client, seen } = page("valid.html");
    const { listings, outcome } = await run(PAGE, client);
    expect(outcome).toMatchObject({ kind: "complete", pages: 1, listings: 2, etag: null });
    expect(seen[0]?.headers.accept).toBe("text/html,application/xhtml+xml");
    expect(listings[0]).toMatchObject({
      providerJobId: "QA-1",
      title: "QA Engineer",
      descriptionText: "Test & automate",
      location: "Tel Aviv, Israel",
      extraLocations: ["Tel Aviv", "Israel"],
      commitment: "FULL_TIME, CONTRACTOR",
      applicationUrl: "https://acme.test/jobs/qa-1",
      salary: { min: 20000, max: 30000, currency: "ILS", period: "month" },
    });
    expect(listings[0]?.publishedAt?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(listings[1]).toMatchObject({
      providerJobId: "DEV-2",
      workplaceType: "remote",
      location: "Haifa, Israel",
      extraLocations: ["Haifa", "Israel", "Berlin"],
      applicationUrl: PAGE,
      salary: null,
    });
  });

  it("yields the valid posting and reports partial when a block is malformed", async () => {
    const { listings, outcome } = await run(PAGE, page("malformed.html").client);
    expect(listings.map((l) => l.providerJobId)).toEqual(["V1"]);
    expect(outcome.kind).toBe("partial");
  });

  it("fails, never completes, when a page has no JSON-LD", async () => {
    const { listings, outcome } = await run(PAGE, page("empty.html").client);
    expect(listings).toEqual([]);
    expect(outcome).toMatchObject({ kind: "failed", reason: "No JobPosting found" });
  });

  it("fails when the only JSON-LD is not a JobPosting", async () => {
    const { outcome } = await run(PAGE, page("nojob.html").client);
    expect(outcome).toMatchObject({ kind: "failed", reason: "No JobPosting found" });
  });

  it("skips expired postings without counting them as invalid", async () => {
    const { listings, outcome } = await run(PAGE, page("expired.html").client);
    expect(listings.map((l) => l.providerJobId)).toEqual(["O1"]);
    expect(outcome.kind).toBe("complete");
  });

  it("fails, rather than reporting an empty board, when every posting looks expired", async () => {
    const html =
      '<script type="application/ld+json">{"@type":"JobPosting","title":"Old","identifier":"X1","validThrough":"2020-01-01"}</script>';
    const { listings, outcome } = await run(PAGE, http(() => ok(html)).client);
    expect(listings).toEqual([]);
    expect(outcome).toMatchObject({ kind: "failed", reason: "Every JobPosting found has expired" });
  });

  it("falls back from identifier to https url to page url plus title", async () => {
    const { listings } = await run(PAGE, page("fallback.html").client);
    expect(listings.map((l) => l.providerJobId)).toEqual([`${PAGE}#No Id`, "https://acme.test/jobs/u", "ID-9"]);
    expect(listings[0]?.applicationUrl).toBe(PAGE);
  });

  it("turns an unexpected posting shape into an invalid record, not a throw", async () => {
    const html = '<script type="application/ld+json">{"@type":"JobPosting","title":{"x":1},"jobLocation":7}</script>';
    const { outcome } = await run(PAGE, http(() => ok(html)).client);
    expect(outcome.kind).toBe("partial");
  });

  it("walks ItemList wrappers", async () => {
    const html =
      '<script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"@type":"ListItem","item":{"@type":["Thing","JobPosting"],"title":"Nested","identifier":"N1"}}]}</script>';
    const { listings } = await run(PAGE, http(() => ok(html)).client);
    expect(listings.map((l) => l.providerJobId)).toEqual(["N1"]);
  });

  it("rejects a non-https providerKey without fetching", async () => {
    const { client, seen } = page("valid.html");
    for (const key of ["http://acme.test/careers", "acme", ""]) {
      const { outcome } = await run(key, client);
      expect(outcome).toMatchObject({ kind: "failed", reason: "Invalid careers URL" });
    }
    expect(seen).toEqual([]);
  });

  it("reports failed and blocked fetches with zero pages", async () => {
    expect((await run(PAGE, http(() => status(500)).client)).outcome).toMatchObject({ kind: "failed", pages: 0 });
    expect((await run(PAGE, http(() => status(403)).client)).outcome).toMatchObject({ kind: "blocked", pages: 0 });
  });

  it("never sends or returns an etag, and treats an unconditional 304 as failed", async () => {
    const { client, seen } = http(() => ok(fixture("valid.html")));
    const { outcome } = await run(PAGE, client, "stored");
    expect(seen[0]?.headers["if-none-match"]).toBeUndefined();
    expect(outcome).toMatchObject({ etag: null });
    expect((await run(PAGE, http(() => status(304)).client, "stored")).outcome.kind).toBe("failed");
  });
});

describe("jsonld connector, sitemap mode", () => {
  const SITEMAP = "https://acme.test/sitemap.xml";
  const detail = (url: URL) => ok(fixture(`detail-${url.pathname.split("/").pop()}.html`));

  it("fetches same-host pages once each, skips foreign hosts, one CrawlPage per page", async () => {
    const { client, seen } = http((url) => (url.pathname === "/sitemap.xml" ? ok(fixture("sitemap.xml")) : detail(url)));
    const { pages, listings, outcome } = await run(SITEMAP, client);
    expect(seen.map((s) => s.url)).toEqual([SITEMAP, "https://acme.test/jobs/1", "https://acme.test/jobs/2", "https://acme.test/jobs/3"]);
    expect(seen[0]?.headers.accept).toBe("application/xml,text/xml");
    expect(seen[1]?.headers.accept).toBe("text/html,application/xhtml+xml");
    expect(pages).toHaveLength(3);
    expect(listings.map((l) => l.providerJobId)).toEqual(["J1", "J2", "J3"]);
    expect(outcome).toMatchObject({ kind: "complete", pages: 3, listings: 3, etag: null });
  });

  it("is partial when a detail page fails, keeping the others", async () => {
    const { client } = http((url) =>
      url.pathname === "/sitemap.xml" ? ok(fixture("sitemap.xml")) : url.pathname === "/jobs/2" ? status(500) : detail(url),
    );
    const { listings, outcome } = await run(SITEMAP, client);
    expect(listings.map((l) => l.providerJobId)).toEqual(["J1", "J3"]);
    expect(outcome).toMatchObject({ kind: "partial", pages: 2 });
  });

  it("caps detail pages and reports partial", async () => {
    const urls = Array.from({ length: JSONLD_MAX_DETAIL_PAGES + 5 }, (_, i) => `<loc>https://acme.test/jobs/${i}</loc>`).join("");
    const { client, seen } = http((url) =>
      url.pathname === "/sitemap.xml"
        ? ok(`<urlset>${urls}</urlset>`)
        : ok(`<script type="application/ld+json">{"@type":"JobPosting","title":"T","identifier":"${url.pathname}"}</script>`),
    );
    const { outcome } = await run(SITEMAP, client);
    expect(seen).toHaveLength(1 + JSONLD_MAX_DETAIL_PAGES);
    expect(outcome).toMatchObject({ kind: "partial", reason: "Detail page limit reached" });
  });

  it("fails when the sitemap lists no usable pages", async () => {
    const { outcome } = await run(SITEMAP, http(() => ok("<urlset><url><loc>https://other.test/a</loc></url></urlset>")).client);
    expect(outcome).toMatchObject({ kind: "failed", reason: "No JobPosting found" });
  });
});
