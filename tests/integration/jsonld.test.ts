import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { jsonldConnector } from "../../src/connectors/jsonld";
import type { Pool } from "../../src/db/pool";
import { HttpClient, type Transport } from "../../src/http/client";
import { crawl } from "../../src/ingest/crawl";
import { addSource, crawlOptions, listingStates, openPool, resetDatabase, testDeps } from "./helpers";

const pool: Pool = openPool();
afterAll(() => pool.end());

const KEY = "https://acme.test/careers";
const posting = (id: string) => ({ "@type": "JobPosting", title: `QA Engineer ${id}`, identifier: id, jobLocation: { address: "Tel Aviv, Israel" } });
const ld = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

const pages: string[] = [];
const transport: Transport = async () => {
  const body = pages.shift();
  if (body === undefined) throw new Error("no page scripted");
  return { status: 200, body, headers: {} };
};

const run = () =>
  crawl(
    testDeps(pool, jsonldConnector, {
      http: new HttpClient({ transport, sleep: async () => {}, random: () => 0, hostIntervalMs: {}, maxRetries: 0 }),
      connectors: { greenhouse: jsonldConnector, lever: jsonldConnector, ashby: jsonldConnector, workable: jsonldConnector, jsonld: jsonldConnector, workday: jsonldConnector },
    }),
    crawlOptions(),
  );

beforeEach(async () => {
  await resetDatabase(pool);
  await addSource(pool, "Acme", KEY, "jsonld");
  pages.length = 0;
});

describe("jsonld source", () => {
  it("never expires jobs when a later crawl finds no postings, or only some of them", async () => {
    pages.push(ld([posting("a"), posting("b")]));
    expect((await run()).sources[0]?.outcome).toBe("complete");
    expect(await listingStates(pool)).toEqual({ a: ["active", 0], b: ["active", 0] });

    pages.push("<html><body>redesigned, no data</body></html>");
    expect((await run()).sources[0]?.outcome).toBe("failed");
    expect(await listingStates(pool)).toEqual({ a: ["active", 0], b: ["active", 0] });

    pages.push(`${ld(posting("a"))}<script type="application/ld+json">{ broken</script>`);
    expect((await run()).sources[0]?.outcome).toBe("partial");
    expect(await listingStates(pool)).toEqual({ a: ["active", 0], b: ["active", 0] });
  });
});
