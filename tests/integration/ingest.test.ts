import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrawlOutcome } from "../../src/connectors/types";
import { crawl } from "../../src/ingest/crawl";
import { listEnabledSources } from "../../src/ingest/sources";
import type { Pool } from "../../src/db/pool";
import {
  addSource,
  crawlOptions,
  eventTypes,
  listingStates,
  openPool,
  rawListing,
  resetDatabase,
  runCrawl,
  scriptedConnector,
  snapshot,
  testDeps,
  type Script,
} from "./helpers";

const pool: Pool = openPool();
afterAll(() => pool.end());
beforeEach(async () => {
  await resetDatabase(pool);
  await addSource(pool);
});

const A = rawListing("a");
const B = rawListing("b");
const C = rawListing("c");
const D = rawListing("d");
const E = rawListing("e");
const FULL = [A, B, C, D, E];

const failedPage = (kind: "failed" | "blocked" | "partial"): Script => ({
  pages: [{ listings: [B, C, D, E], invalidRecords: 0 }],
  outcome: { kind, pages: 1, reason: "scripted", httpStatus: kind === "blocked" ? 403 : 500 } as CrawlOutcome,
});

async function play(scripts: Script[]) {
  const { connector, etags } = scriptedConnector("greenhouse", scripts);
  const summaries = [];
  while (scripts.length > 0) summaries.push(await runCrawl(pool, connector));
  return { summaries, etags };
}

describe("ingestion", () => {
  it("does not duplicate listings or events across repeated runs", async () => {
    await play([snapshot(FULL), snapshot(FULL), snapshot(FULL)]);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM source_listings`);
    expect(rows[0].n).toBe(5);
    expect(await eventTypes(pool)).toHaveLength(5);
  });

  it("treats the first snapshot as a baseline and later discoveries as news", async () => {
    await play([snapshot(FULL), snapshot([...FULL, rawListing("f")])]);
    const { rows } = await pool.query(
      `SELECT count(*) FILTER (WHERE during_baseline)::int AS baseline, count(*) FILTER (WHERE NOT during_baseline)::int AS fresh FROM job_events`,
    );
    expect(rows[0]).toEqual({ baseline: 5, fresh: 1 });
  });

  it("keeps a page committed before a later failure", async () => {
    await play([failedPage("failed")]);
    expect(Object.keys(await listingStates(pool))).toEqual(["b", "c", "d", "e"]);
  });

  it("does not store listings outside Israel", async () => {
    await play([snapshot([A, rawListing("nyc", { location: "New York, NY" })])]);
    expect(Object.keys(await listingStates(pool))).toEqual(["a"]);
    const { rows } = await pool.query(`SELECT listings_seen, listings_out_of_scope FROM source_snapshots`);
    expect(rows[0]).toEqual({ listings_seen: 2, listings_out_of_scope: 1 });
  });

  it("records observation separately from verification", async () => {
    await play([failedPage("partial")]);
    const { rows } = await pool.query(`SELECT last_seen_at, last_verified_at FROM source_listings LIMIT 1`);
    expect(rows[0].last_seen_at).not.toBeNull();
    expect(rows[0].last_verified_at).toBeNull();
    await play([snapshot(FULL)]);
    const after = await pool.query(`SELECT count(*)::int AS n FROM source_listings WHERE last_verified_at IS NULL`);
    expect(after.rows[0].n).toBe(0);
  });

  it("counts a significant change once and ignores formatting", async () => {
    const reformatted = { ...A, originalDescription: `<div><b>${A.descriptionText}</b></div>` };
    await play([snapshot(FULL), snapshot([reformatted, B, C, D, E])]);
    expect((await eventTypes(pool)).filter((event) => event.startsWith("changed"))).toEqual([]);

    const retitled = { ...A, title: "Senior QA Automation Engineer" };
    await play([snapshot([retitled, B, C, D, E]), snapshot([retitled, B, C, D, E])]);
    const { rows } = await pool.query(
      `SELECT significant, changed_fields, revision FROM job_events WHERE event_type = 'changed'`,
    );
    expect(rows).toEqual([{ significant: true, changed_fields: ["title", "seniority"], revision: 2 }]);
  });

  it("records description-only changes as revisions that do not alert", async () => {
    const reworded = { ...A, descriptionText: "Different words about the team." };
    await play([snapshot(FULL), snapshot([reworded, B, C, D, E])]);
    const { rows } = await pool.query(`SELECT significant, changed_fields FROM job_events WHERE event_type = 'changed'`);
    expect(rows).toEqual([{ significant: false, changed_fields: ["description"] }]);
  });

  it("does not report a salary change when the salary is unchanged after a jsonb round trip", async () => {
    const paid = { ...A, salary: { min: 1, max: 2, currency: "ILS", period: "month", basis: null } };
    await play([snapshot([paid, B, C, D, E]), snapshot([{ ...paid, title: "Lead QA" }, B, C, D, E])]);
    const { rows } = await pool.query(`SELECT changed_fields FROM job_events WHERE event_type = 'changed'`);
    expect(rows[0].changed_fields).not.toContain("salary");
  });
});

describe("freshness", () => {
  it("expires only after two consecutive complete absences", async () => {
    await play([snapshot(FULL), snapshot([B, C, D, E])]);
    expect((await listingStates(pool)).a).toEqual(["active", 1]);
    await play([snapshot([B, C, D, E])]);
    expect((await listingStates(pool)).a).toEqual(["expired", 2]);
    expect((await eventTypes(pool)).at(-1)).toBe("expired:1");
  });

  it("resets the absence count when a listing returns inside the grace period", async () => {
    await play([snapshot(FULL), snapshot([B, C, D, E]), snapshot(FULL)]);
    expect((await listingStates(pool)).a).toEqual(["active", 0]);
    expect(await eventTypes(pool)).toHaveLength(5);
  });

  it.each(["partial", "failed", "blocked"] as const)("never counts absence from a %s crawl", async (kind) => {
    await play([snapshot(FULL), failedPage(kind), failedPage(kind), failedPage(kind)]);
    expect((await listingStates(pool)).a).toEqual(["active", 0]);
    const { rows } = await pool.query(`SELECT outcome FROM source_snapshots ORDER BY id DESC LIMIT 1`);
    expect(rows[0].outcome).toBe(kind);
  });

  it("does not trust a thrown crawl", async () => {
    const { connector } = scriptedConnector("greenhouse", [snapshot(FULL)]);
    await runCrawl(pool, connector);
    const broken = scriptedConnector("greenhouse", []);
    const summary = await runCrawl(pool, broken.connector);
    expect(summary.status).toBe("failed");
    expect((await listingStates(pool)).a).toEqual(["active", 0]);
    const { rows } = await pool.query(`SELECT crawl_lease_owner FROM job_sources`);
    expect(rows[0].crawl_lease_owner).toBeNull();
  });

  it("treats an empty board as suspicious and keeps its jobs", async () => {
    const { summaries } = await play([snapshot(FULL), snapshot([])]);
    expect(summaries[1]?.sources[0]?.outcome).toBe("suspicious");
    expect((await listingStates(pool)).a).toEqual(["active", 0]);
  });

  it("treats a large drop as suspicious without moving the checkpoint", async () => {
    const { summaries } = await play([snapshot(FULL, "v1"), snapshot([A], "v2")]);
    expect(summaries[1]?.sources[0]?.outcome).toBe("suspicious");
    const { rows } = await pool.query(`SELECT checkpoint_etag, last_listing_count FROM job_sources`);
    expect(rows[0]).toEqual({ checkpoint_etag: "v1", last_listing_count: 5 });
  });

  it("believes a closure that repeats for the grace period", async () => {
    await play([snapshot(FULL), snapshot([]), snapshot([]), snapshot([])]);
    expect((await listingStates(pool)).a).toEqual(["active", 1]);
    await play([snapshot([])]);
    expect((await listingStates(pool)).a).toEqual(["expired", 2]);
  });

  it("creates reopened events per cycle, even with identical content", async () => {
    const gone = [B, C, D, E];
    await play([snapshot(FULL), snapshot(gone), snapshot(gone), snapshot(FULL), snapshot(gone), snapshot(gone), snapshot(FULL)]);
    const events = (await eventTypes(pool)).filter((event) => !event.startsWith("discovered"));
    expect(events).toEqual(["expired:1", "reopened:2", "expired:2", "reopened:3"]);
    expect((await listingStates(pool)).a).toEqual(["active", 0]);
  });

  it("reopens from a partial crawl, because observation is positive evidence", async () => {
    const gone = [B, C, D, E];
    await play([
      snapshot(FULL),
      snapshot(gone),
      snapshot(gone),
      { pages: [{ listings: [A], invalidRecords: 0 }], outcome: { kind: "partial", pages: 1, reason: "x", httpStatus: 500 } },
    ]);
    expect((await listingStates(pool)).a).toEqual(["active", 0]);
    expect((await eventTypes(pool)).at(-1)).toBe("reopened:2");
  });

  it("replays reconciliation without double counting", async () => {
    await play([snapshot(FULL), snapshot([B, C, D, E])]);
    const { reconcileSnapshot } = await import("../../src/ingest/reconcile");
    const [source] = await listEnabledSources(pool);
    const { rows } = await pool.query(`SELECT max(id) AS id FROM source_snapshots`);
    await reconcileSnapshot(pool, source!, rows[0].id, 4, null, { graceSnapshots: 2, suspiciousDropRatio: 0.5 });
    expect((await listingStates(pool)).a).toEqual(["active", 1]);
  });
});

describe("conditional requests", () => {
  const notModified: Script = { pages: [], outcome: { kind: "not_modified", pages: 1, httpStatus: 304 } };

  it("verifies listings on a 304 and sends the stored ETag", async () => {
    const { etags } = await play([snapshot(FULL, "v1"), notModified]);
    expect(etags).toEqual([null, "v1"]);
    const { rows } = await pool.query(`SELECT outcome FROM source_snapshots ORDER BY id`);
    expect(rows.map((row) => row.outcome)).toEqual(["complete", "not_modified"]);
  });

  it("keeps counting absence across a 304", async () => {
    await play([snapshot(FULL, "v1"), snapshot([B, C, D, E], "v2"), notModified]);
    expect((await listingStates(pool)).a).toEqual(["expired", 2]);
    expect((await listingStates(pool)).b).toEqual(["active", 0]);
  });

  it("does not advance the checkpoint on a partial crawl", async () => {
    const partial: Script = {
      pages: [{ listings: FULL, invalidRecords: 0 }],
      outcome: { kind: "partial", pages: 1, reason: "x", httpStatus: 200 },
    };
    const { etags } = await play([snapshot(FULL, "v1"), partial, snapshot(FULL, "v2")]);
    expect(etags).toEqual([null, "v1", "v1"]);
  });

  it("ignores the ETag on a full crawl and after a normalizer change", async () => {
    const first = scriptedConnector("greenhouse", [snapshot(FULL, "v1"), snapshot(FULL, "v1")]);
    await runCrawl(pool, first.connector);
    await runCrawl(pool, first.connector, { mode: "full" });
    expect(first.etags).toEqual([null, null]);

    await pool.query(`UPDATE source_listings SET normalization_version = 'normalize-v0'`);
    const second = scriptedConnector("greenhouse", [snapshot(FULL, "v2")]);
    await runCrawl(pool, second.connector);
    expect(second.etags).toEqual([null]);
  });

  it("does not raise alerts when a normalizer upgrade changes derived fields", async () => {
    await play([snapshot(FULL)]);
    await pool.query(
      `UPDATE source_listings SET normalization_version = 'normalize-v0', seniority = 'lead', content_hash = 'old'`,
    );
    await play([snapshot(FULL)]);
    const { rows } = await pool.query(`SELECT count(*)::int AS n, bool_or(significant) AS any FROM job_events WHERE event_type = 'changed'`);
    expect(rows[0]).toEqual({ n: 5, any: false });
  });
});

describe("concurrency", () => {
  it("lets only one of two simultaneous crawls take a source", async () => {
    let finish = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const connector = {
      provider: "greenhouse" as const,
      async *crawl() {
        yield { listings: FULL, invalidRecords: 0 };
        await gate;
        return { kind: "complete", pages: 1, listings: 5, etag: null, httpStatus: 200 } as CrawlOutcome;
      },
    };
    const holding = runCrawl(pool, connector);
    await vi.waitFor(async () => {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM source_listings`);
      expect(rows[0].n).toBe(5);
    });
    const second = await runCrawl(pool, connector);
    finish();
    const first = await holding;
    expect(first.sources[0]?.outcome).toBe("complete");
    expect(second.sources[0]?.outcome).toBe("skipped");
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM source_listings`);
    expect(rows[0].n).toBe(5);
  });

  it("aborts a crawl that lost its lease before it can reconcile", async () => {
    const steal = async () => {
      await pool.query(`UPDATE job_sources SET crawl_lease_owner = 'someone-else'`);
    };
    const connector = {
      provider: "greenhouse" as const,
      async *crawl() {
        yield { listings: [A], invalidRecords: 0 };
        await steal();
        return { kind: "complete", pages: 1, listings: 1, etag: "stolen", httpStatus: 200 } as CrawlOutcome;
      },
    };
    const summary = await crawl(testDeps(pool, connector), crawlOptions());
    expect(summary.sources[0]?.outcome).toBe("failed");
    const { rows } = await pool.query(`SELECT checkpoint_etag, crawl_lease_owner FROM job_sources`);
    expect(rows[0]).toEqual({ checkpoint_etag: null, crawl_lease_owner: "someone-else" });
  });

  it("stops at the time budget without trusting the snapshot", async () => {
    let clock = 0;
    const connector = {
      provider: "greenhouse" as const,
      async *crawl() {
        yield { listings: [A], invalidRecords: 0 };
        clock = 1_000_000;
        yield { listings: [B], invalidRecords: 0 };
        yield { listings: [C], invalidRecords: 0 };
        return { kind: "complete", pages: 3, listings: 3, etag: null, httpStatus: 200 } as CrawlOutcome;
      },
    };
    const summary = await crawl(testDeps(pool, connector, { now: () => clock }), crawlOptions());
    expect(summary.sources[0]?.outcome).toBe("partial");
    expect(Object.keys(await listingStates(pool))).toEqual(["a", "b"]);
  });

  it("closes runs abandoned by a crash", async () => {
    const { rows } = await pool.query(
      `INSERT INTO crawl_runs (trigger, mode, started_at) VALUES ('test', 'full', now() - interval '1 day') RETURNING id`,
    );
    await play([snapshot(FULL)]);
    const after = await pool.query(`SELECT status FROM crawl_runs WHERE id = $1`, [rows[0].id]);
    expect(after.rows[0].status).toBe("failed");
  });
});

describe("cross-source deduplication", () => {
  const twoSources = async () => {
    await addSource(pool, "Fixture Co", "fixture-lever", "lever");
  };
  const canonicalCount = async () =>
    (await pool.query(`SELECT count(*)::int AS n FROM canonical_jobs`)).rows[0].n as number;

  it("merges on a requisition id across a company's sources", async () => {
    await twoSources();
    const { connector } = scriptedConnector("greenhouse", [
      snapshot([rawListing("a", { requisitionId: "REQ-123" })]),
      snapshot([rawListing("z", { requisitionId: "REQ-123" })]),
    ]);
    await runCrawl(pool, connector);
    expect(await canonicalCount()).toBe(1);
  });

  it("merges on a canonical URL", async () => {
    await twoSources();
    const { connector } = scriptedConnector("greenhouse", [
      snapshot([rawListing("a", { applicationUrl: "https://example.test/jobs/1?utm_source=x" })]),
      snapshot([rawListing("z", { applicationUrl: "https://www.example.test/jobs/1/" })]),
    ]);
    await runCrawl(pool, connector);
    expect(await canonicalCount()).toBe(1);
  });

  it("never merges on company and title alone", async () => {
    await twoSources();
    const title = "QA Automation Engineer";
    const { connector } = scriptedConnector("greenhouse", [snapshot([rawListing("a", { title })]), snapshot([rawListing("z", { title })])]);
    await runCrawl(pool, connector);
    expect(await canonicalCount()).toBe(2);
  });

  it("ignores placeholder requisition ids and the same id on another company", async () => {
    await twoSources();
    await addSource(pool, "Other Co", "other");
    const { connector } = scriptedConnector("greenhouse", [
      snapshot([rawListing("a", { requisitionId: "N/A" }), rawListing("b", { requisitionId: "REQ-9" })]),
      snapshot([rawListing("z", { requisitionId: "N/A" })]),
      snapshot([rawListing("y", { requisitionId: "REQ-9" })]),
    ]);
    await runCrawl(pool, connector, { concurrency: 1 });
    expect(await canonicalCount()).toBe(4);
  });

  it("never merges two listings of the same source", async () => {
    const { connector } = scriptedConnector("greenhouse", [
      snapshot([rawListing("a", { requisitionId: "REQ-1" }), rawListing("b", { requisitionId: "REQ-1" })]),
    ]);
    await runCrawl(pool, connector);
    expect(await canonicalCount()).toBe(2);
  });

  it("merges safely when both sources write at once", async () => {
    await twoSources();
    const { connector } = scriptedConnector("greenhouse", [
      snapshot([rawListing("a", { requisitionId: "REQ-7" })]),
      snapshot([rawListing("z", { requisitionId: "REQ-7" })]),
    ]);
    await runCrawl(pool, connector, { concurrency: 2 });
    expect(await canonicalCount()).toBe(1);
  });

  it("keeps a canonical job active while another source still lists it", async () => {
    await twoSources();
    const req = { requisitionId: "REQ-5" };
    const present = [rawListing("a", req), B, C, D, E];
    const { connector } = scriptedConnector("greenhouse", [
      snapshot(present),
      snapshot([rawListing("z", req)]),
      snapshot([B, C, D, E]),
      snapshot([rawListing("z", req)]),
      snapshot([B, C, D, E]),
      snapshot([rawListing("z", req)]),
    ]);
    await runCrawl(pool, connector, { concurrency: 1 });
    await runCrawl(pool, connector, { concurrency: 1 });
    await runCrawl(pool, connector, { concurrency: 1 });
    expect((await listingStates(pool)).a).toEqual(["expired", 2]);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM canonical_jobs WHERE status = 'expired'`);
    expect(rows[0].n).toBe(0);
  });
});
