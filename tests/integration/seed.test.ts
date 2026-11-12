import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { migrate } from "../../src/db/migrate";
import { CATALOG_PATH, seedCatalog } from "../../src/ingest/seed";
import { listEnabledSources } from "../../src/ingest/sources";
import { addSource, openPool, resetDatabase } from "./helpers";

const pool = openPool();
afterAll(() => pool.end());
beforeEach(() => resetDatabase(pool));

describe("catalog", () => {
  it("seeds repeatably and disables sources removed from the file", async () => {
    await addSource(pool, "Gone Co", "gone");
    const first = await seedCatalog(pool);
    expect(first.disabled).toBe(1);
    const second = await seedCatalog(pool);
    expect(second).toEqual({ sources: first.sources, disabled: 0 });
    expect(await listEnabledSources(pool)).toHaveLength(first.sources);
  });

  it("filters by provider and company", async () => {
    await seedCatalog(pool);
    const lever = await listEnabledSources(pool, { provider: "lever" });
    expect(lever.every((source) => source.provider === "lever")).toBe(true);
    expect(await listEnabledSources(pool, { company: "nanit" })).toHaveLength(1);
  });

  it("accepts every catalog provider in the database", async () => {
    await seedCatalog(pool);
    const ashby = await listEnabledSources(pool, { provider: "ashby" });
    expect(ashby.length).toBeGreaterThan(0);
    await expect(addSource(pool, "Unknown Co", "unknown", "smartrecruiters" as never)).rejects.toThrow(/job_sources_provider_check/);
  });

  it("contains no synthetic companies", async () => {
    const text = await readFile(CATALOG_PATH, "utf8");
    expect(text).not.toMatch(/example\.|fixture|synthetic company/i);
  });
});

describe("migrations", () => {
  it("applies nothing on a second run", async () => {
    expect(await migrate(pool)).toEqual([]);
  });

  it("enforces one row per provider job within a source", async () => {
    const source = await addSource(pool);
    const { rows } = await pool.query(`INSERT INTO canonical_jobs (company_id, title, content_hash) VALUES (1, 't', 'h') RETURNING id`);
    const insert = () =>
      pool.query(
        `INSERT INTO source_listings (source_id, provider_job_id, canonical_job_id, title, original_description,
           description_text, application_url, canonical_url, content_hash, normalization_version)
         VALUES ($1, 'x', $2, 't', 'd', 'd', 'https://a.test', 'https://a.test', 'h', 'v')`,
        [source, rows[0].id],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/unique/i);
  });
});
