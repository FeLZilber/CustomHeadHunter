import type { Provider } from "../connectors/types";
import type { Queryable } from "../db/pool";

export interface Source {
  id: string;
  companyId: string;
  companyName: string;
  provider: Provider;
  providerKey: string;
  checkpointEtag: string | null;
  baselineEstablished: boolean;
  lastListingCount: number | null;
}

export interface SourceFilter {
  provider?: Provider;
  company?: string;
}

/** Least recently completed sources come first, so a time budget cannot starve the same ones. */
export async function listEnabledSources(db: Queryable, filter: SourceFilter = {}): Promise<Source[]> {
  const { rows } = await db.query(
    `SELECT s.id, s.company_id, c.name, s.provider, s.provider_key, s.checkpoint_etag,
            s.baseline_established_at IS NOT NULL AS baseline_established, s.last_listing_count
       FROM job_sources s JOIN companies c ON c.id = s.company_id
      WHERE s.enabled
        AND ($1::text IS NULL OR s.provider = $1)
        AND ($2::text IS NULL OR lower(c.name) = lower($2))
      ORDER BY s.last_complete_snapshot_at ASC NULLS FIRST, s.id`,
    [filter.provider ?? null, filter.company ?? null],
  );
  return rows.map((row) => ({
    id: row.id,
    companyId: row.company_id,
    companyName: row.name,
    provider: row.provider,
    providerKey: row.provider_key,
    checkpointEtag: row.checkpoint_etag,
    baselineEstablished: row.baseline_established,
    lastListingCount: row.last_listing_count,
  }));
}

export async function claimSource(db: Queryable, sourceId: string, owner: string, leaseSeconds: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE job_sources
        SET crawl_lease_owner = $2, crawl_lease_until = now() + make_interval(secs => $3)
      WHERE id = $1 AND (crawl_lease_until IS NULL OR crawl_lease_until < now())`,
    [sourceId, owner, leaseSeconds],
  );
  return rowCount === 1;
}

export class LeaseLostError extends Error {
  constructor(sourceId: string) {
    super(`Lost the crawl lease for source ${sourceId}`);
    this.name = "LeaseLostError";
  }
}

/** Renews the lease and proves ownership in one step. Call it first in every write transaction. */
export async function assertLease(db: Queryable, sourceId: string, owner: string, leaseSeconds: number): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE job_sources SET crawl_lease_until = now() + make_interval(secs => $3)
      WHERE id = $1 AND crawl_lease_owner = $2 AND crawl_lease_until >= now()`,
    [sourceId, owner, leaseSeconds],
  );
  if (rowCount !== 1) throw new LeaseLostError(sourceId);
}

export async function releaseSource(db: Queryable, sourceId: string, owner: string): Promise<void> {
  await db.query(
    `UPDATE job_sources SET crawl_lease_owner = NULL, crawl_lease_until = NULL
      WHERE id = $1 AND crawl_lease_owner = $2`,
    [sourceId, owner],
  );
}

/** Serializes writers per company, because canonical jobs may span a company's sources. */
export async function lockCompany(db: Queryable, companyId: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`company:${companyId}`]);
}
