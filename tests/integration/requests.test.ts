import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readSourceRequests, requestSource } from "../../src/dashboard/queries";
import { migrate } from "../../src/db/migrate";
import { HttpClient } from "../../src/http/client";
import { adoptRequestedSources } from "../../src/ingest/requests";
import { seedCatalog } from "../../src/ingest/seed";
import type { ProbeResult } from "../../src/ingest/probe";
import { openPool, resetDatabase } from "./helpers";

const pool = openPool();
const http = new HttpClient();
beforeAll(() => migrate(pool));
afterAll(() => pool.end());
beforeEach(() => resetDatabase(pool));

const probeAs = (result: Partial<ProbeResult>) => async (_: HttpClient, provider: ProbeResult["provider"], key: string): Promise<ProbeResult> =>
  ({ provider, providerKey: key, status: "found", total: 10, israeli: 3, qaTitles: 1, ...result });

const sources = async () => (await pool.query(`SELECT provider_key, enabled, origin FROM job_sources WHERE origin = 'requested'`)).rows;

describe("requested sources", () => {
  it("adds a board with Israeli jobs as a source that survives a catalog seed", async () => {
    await requestSource(pool, { provider: "lever", providerKey: "acme" }, "Acme");
    expect(await adoptRequestedSources(pool, http, probeAs({}))).toEqual({ added: 1, rejected: 0, retry: 0 });
    expect(await sources()).toEqual([{ provider_key: "acme", enabled: true, origin: "requested" }]);
    await seedCatalog(pool);
    expect(await sources()).toEqual([{ provider_key: "acme", enabled: true, origin: "requested" }]);
    expect((await readSourceRequests(pool))[0]).toMatchObject({ status: "added", detail: "3 Israeli jobs of 10" });
  });

  it("rejects a missing board or one without Israeli jobs, and may be asked again", async () => {
    await requestSource(pool, { provider: "lever", providerKey: "ghost" }, "Ghost");
    await requestSource(pool, { provider: "ashby", providerKey: "abroad" }, "Abroad");
    const probe = async (_: HttpClient, provider: ProbeResult["provider"], key: string): Promise<ProbeResult> =>
      key === "ghost"
        ? { provider, providerKey: key, status: "missing", total: 0, israeli: 0, qaTitles: 0 }
        : { provider, providerKey: key, status: "found", total: 5, israeli: 0, qaTitles: 0 };
    expect(await adoptRequestedSources(pool, http, probe)).toEqual({ added: 0, rejected: 2, retry: 0 });
    expect(await sources()).toEqual([]);
    await requestSource(pool, { provider: "ashby", providerKey: "abroad" }, "Abroad");
    expect((await readSourceRequests(pool)).find((r) => r.providerKey === "abroad")?.status).toBe("pending");
  });

  it("keeps a request pending when the board cannot be reached", async () => {
    await requestSource(pool, { provider: "lever", providerKey: "flaky" }, "Flaky");
    expect(await adoptRequestedSources(pool, http, probeAs({ status: "error" }))).toEqual({ added: 0, rejected: 0, retry: 1 });
    expect((await readSourceRequests(pool))[0]?.status).toBe("pending");
    expect(await adoptRequestedSources(pool, http, async () => { throw new Error("network"); })).toMatchObject({ retry: 1 });
  });

  it("does not reopen a request that was already added", async () => {
    await requestSource(pool, { provider: "lever", providerKey: "acme" }, "Acme");
    await adoptRequestedSources(pool, http, probeAs({}));
    await requestSource(pool, { provider: "lever", providerKey: "acme" }, "Acme");
    expect((await readSourceRequests(pool))[0]?.status).toBe("added");
  });
});
