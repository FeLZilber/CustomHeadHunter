import { describe, expect, it } from "vitest";
import { greenhouseConnector } from "../../src/connectors/greenhouse";
import { LEVER_MAX_PAGES, LEVER_PAGE_SIZE, leverConnector } from "../../src/connectors/lever";
import type { Connector, CrawlOutcome, CrawlPage, RawListing } from "../../src/connectors/types";
import { HttpClient, type Transport, type TransportResponse } from "../../src/http/client";

const json = (body: unknown, headers: Record<string, string> = {}): TransportResponse => ({
  status: 200,
  body: JSON.stringify(body),
  headers,
});
const status = (code: number): TransportResponse => ({ status: code, body: "", headers: {} });

function http(handler: (url: URL, headers: Record<string, string>) => TransportResponse) {
  const urls: string[] = [];
  const transport: Transport = async (url, headers) => {
    urls.push(url.toString());
    return handler(url, headers);
  };
  return { client: new HttpClient({ transport, sleep: async () => {}, random: () => 0, hostIntervalMs: {} }), urls };
}

async function collect(connector: Connector, client: HttpClient, etag: string | null = null) {
  const pages: CrawlPage[] = [];
  const generator = connector.crawl({ providerKey: "acme", etag }, client);
  let step = await generator.next();
  while (!step.done) {
    pages.push(step.value);
    step = await generator.next();
  }
  return { pages, outcome: step.value as CrawlOutcome, listings: pages.flatMap((page) => page.listings) as RawListing[] };
}

const greenhouseJob = (id: number, overrides: object = {}) => ({
  id,
  title: "QA Automation Engineer",
  absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
  location: { name: "Tel Aviv" },
  content: "&lt;p&gt;Playwright &amp;amp; TypeScript&lt;/p&gt;",
  requisition_id: "REQ-1",
  updated_at: "2026-10-01T00:00:00-04:00",
  first_published: "2026-09-01T00:00:00-04:00",
  offices: [{ name: "Israel", location: "Tel Aviv, Israel" }],
  ...overrides,
});

describe("greenhouse connector", () => {
  it("maps a job and unescapes its content exactly once", async () => {
    const { client } = http(() => json({ jobs: [greenhouseJob(1)], meta: { total: 1 } }, { etag: "v1" }));
    const { listings, outcome } = await collect(greenhouseConnector, client);
    expect(outcome).toMatchObject({ kind: "complete", listings: 1, etag: "v1" });
    expect(listings[0]).toMatchObject({
      providerJobId: "1",
      requisitionId: "REQ-1",
      descriptionText: "Playwright & TypeScript",
      location: "Tel Aviv",
      extraLocations: ["Israel", "Tel Aviv, Israel"],
    });
    expect(listings[0]?.publishedAt?.toISOString()).toBe("2026-09-01T04:00:00.000Z");
  });

  it("requests the content and sends the ETag", async () => {
    const seen: Record<string, string>[] = [];
    const { client, urls } = http((_url, headers) => {
      seen.push(headers);
      return status(304);
    });
    const { outcome } = await collect(greenhouseConnector, client, "v1");
    expect(outcome.kind).toBe("not_modified");
    expect(urls[0]).toBe("https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true");
    expect(seen[0]?.["if-none-match"]).toBe("v1");
  });

  it("is partial when meta.total disagrees", async () => {
    const { client } = http(() => json({ jobs: [greenhouseJob(1)], meta: { total: 2 } }));
    expect((await collect(greenhouseConnector, client)).outcome.kind).toBe("partial");
  });

  it("is partial on an invalid record but keeps the valid ones", async () => {
    const { client } = http(() => json({ jobs: [greenhouseJob(1), { id: "bad" }], meta: { total: 2 } }));
    const { outcome, listings } = await collect(greenhouseConnector, client);
    expect(outcome.kind).toBe("partial");
    expect(listings).toHaveLength(1);
  });

  it.each([
    [403, "blocked"],
    [404, "failed"],
    [503, "failed"],
  ])("reports HTTP %i as %s", async (code, kind) => {
    const { client } = http(() => status(code));
    expect((await collect(greenhouseConnector, client)).outcome.kind).toBe(kind);
  });

  it("fails on a response that is not the expected shape", async () => {
    expect((await collect(greenhouseConnector, http(() => json({ nope: true })).client)).outcome.kind).toBe("failed");
    const html = http(() => ({ status: 200, body: "<html>", headers: {} })).client;
    expect((await collect(greenhouseConnector, html)).outcome.kind).toBe("failed");
  });

  it("treats a blank requisition id as absent", async () => {
    const { client } = http(() => json({ jobs: [greenhouseJob(1, { requisition_id: "  " })], meta: { total: 1 } }));
    expect((await collect(greenhouseConnector, client)).listings[0]?.requisitionId).toBeNull();
  });
});

const posting = (id: string, overrides: object = {}) => ({
  id,
  text: "QA Automation Engineer",
  hostedUrl: `https://jobs.lever.co/acme/${id}`,
  createdAt: 1_790_000_000_000,
  country: "IL",
  workplaceType: "hybrid",
  categories: { location: "Tel Aviv", commitment: "Full-time", allLocations: ["Tel Aviv", "Haifa"] },
  descriptionPlain: "About the role",
  lists: [{ text: "Requirements", content: "<li>Playwright</li>" }],
  additionalPlain: "Benefits",
  salaryRange: { currency: "ILS", interval: "per-month", min: 30000, max: 40000 },
  ...overrides,
});

const pageOf = (start: number, count: number) => Array.from({ length: count }, (_, index) => posting(`p${start + index}`));

describe("lever connector", () => {
  it("maps a posting, including explicitly supplied salary", async () => {
    const { client } = http(() => json([posting("a")], { etag: "v1" }));
    const { listings, outcome } = await collect(leverConnector, client);
    expect(outcome).toMatchObject({ kind: "complete", etag: "v1" });
    expect(listings[0]).toMatchObject({
      providerJobId: "a",
      workplaceType: "hybrid",
      commitment: "Full-time",
      salary: { min: 30000, max: 40000, currency: "ILS", period: "per-month", basis: null },
    });
    expect(listings[0]?.descriptionText).toContain("Requirements\n- Playwright");
    expect(listings[0]?.extraLocations).toContain("Israel");
  });

  it("follows pages until a short page", async () => {
    const { client, urls } = http((url) => {
      const skip = Number(url.searchParams.get("skip"));
      return json(skip < 200 ? pageOf(skip, LEVER_PAGE_SIZE) : pageOf(skip, 3));
    });
    const { outcome, pages, listings } = await collect(leverConnector, client);
    expect(outcome).toMatchObject({ kind: "complete", pages: 3, listings: 203 });
    expect(pages).toHaveLength(3);
    expect(listings).toHaveLength(203);
    expect(urls[1]).toContain("skip=100&limit=100");
  });

  it("does not keep an ETag for a multi-page board, because it covers one page only", async () => {
    const { client } = http((url) => json(url.searchParams.get("skip") === "0" ? pageOf(0, LEVER_PAGE_SIZE) : [], { etag: "page" }));
    expect((await collect(leverConnector, client)).outcome).toMatchObject({ kind: "complete", etag: null });
  });

  it("is partial when a later page fails, keeping earlier pages", async () => {
    const { client } = http((url) => (url.searchParams.get("skip") === "0" ? json(pageOf(0, LEVER_PAGE_SIZE)) : status(503)));
    const { outcome, listings } = await collect(leverConnector, client);
    expect(outcome).toMatchObject({ kind: "partial", pages: 1 });
    expect(listings).toHaveLength(LEVER_PAGE_SIZE);
  });

  it("is partial when a later page is blocked", async () => {
    const { client } = http((url) => (url.searchParams.get("skip") === "0" ? json(pageOf(0, LEVER_PAGE_SIZE)) : status(403)));
    expect((await collect(leverConnector, client)).outcome.kind).toBe("partial");
  });

  it("removes a posting repeated across pages", async () => {
    const { client } = http((url) => (url.searchParams.get("skip") === "0" ? json(pageOf(0, LEVER_PAGE_SIZE)) : json([posting("p0")])));
    expect((await collect(leverConnector, client)).listings).toHaveLength(LEVER_PAGE_SIZE);
  });

  it("stops at the page limit rather than loop forever", async () => {
    const { client, urls } = http((url) => json(pageOf(Number(url.searchParams.get("skip")), LEVER_PAGE_SIZE)));
    const { outcome } = await collect(leverConnector, client);
    expect(outcome).toMatchObject({ kind: "partial", reason: "Page limit reached" });
    expect(urls).toHaveLength(LEVER_MAX_PAGES);
  });

  it("is partial on an invalid record", async () => {
    const { client } = http(() => json([posting("a"), { id: "b" }]));
    expect((await collect(leverConnector, client)).outcome.kind).toBe("partial");
  });

  it("reports a 304 and a block on the first page", async () => {
    expect((await collect(leverConnector, http(() => status(304)).client, "v1")).outcome.kind).toBe("not_modified");
    expect((await collect(leverConnector, http(() => status(403)).client)).outcome.kind).toBe("blocked");
  });

  it("keeps an empty board as complete for the sanity checks to judge", async () => {
    expect((await collect(leverConnector, http(() => json([])).client)).outcome).toMatchObject({ kind: "complete", listings: 0 });
  });
});
