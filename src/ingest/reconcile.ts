import type { Queryable } from "../db/pool";
import { recordEvent } from "./persist";
import type { Source } from "./sources";

export interface FreshnessSettings {
  graceSnapshots: number;
  suspiciousDropRatio: number;
}

const MIN_DROP_SAMPLE = 4;

export interface SnapshotFacts {
  total: number;
  previousTotal: number | null;
  activeBefore: number;
  /** Excludes listings already absent from an accepted snapshot, which are no longer in doubt. */
  newlyAbsent: number;
}

/** Returns why a "complete" snapshot should not be trusted, or null when it looks sound. */
export function judgeSnapshot(facts: SnapshotFacts, dropRatio: number): string | null {
  const { total, previousTotal, activeBefore, newlyAbsent } = facts;
  if (total === 0 && previousTotal !== 0) return "Empty board";
  if (previousTotal !== null && previousTotal >= MIN_DROP_SAMPLE && total < previousTotal * (1 - dropRatio)) {
    return `Board shrank from ${previousTotal} to ${total}`;
  }
  if (activeBefore >= MIN_DROP_SAMPLE && newlyAbsent / activeBefore > dropRatio) {
    return `${newlyAbsent} of ${activeBefore} active listings are absent`;
  }
  return null;
}

async function expireAbsent(db: Queryable, source: Source, graceSnapshots: number): Promise<number> {
  const { rows } = await db.query(
    `UPDATE source_listings SET status = 'expired', status_changed_at = now()
      WHERE source_id = $1 AND status = 'active' AND missing_snapshots >= $2
      RETURNING canonical_job_id`,
    [source.id, graceSnapshots],
  );
  if (rows.length === 0) return 0;

  const { rows: canonicals } = await db.query(
    `UPDATE canonical_jobs c SET status = 'expired', status_changed_at = now()
      WHERE c.id = ANY($1::bigint[]) AND c.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM source_listings l WHERE l.canonical_job_id = c.id AND l.status = 'active')
      RETURNING id, lifecycle_cycle, revision, content_hash`,
    [rows.map((row) => row.canonical_job_id)],
  );
  for (const canonical of canonicals) {
    await recordEvent(db, {
      canonicalJobId: canonical.id,
      sourceListingId: null,
      type: "expired",
      cycle: canonical.lifecycle_cycle,
      revision: canonical.revision,
      significant: true,
      duringBaseline: false,
      contentHash: canonical.content_hash,
    });
  }
  return rows.length;
}

/** True once the same doubt has repeated for the grace period, so a real closure is eventually believed. */
async function suspicionConfirmed(db: Queryable, sourceId: string, snapshotId: string, graceSnapshots: number) {
  const { rows } = await db.query(
    `SELECT outcome FROM source_snapshots
      WHERE source_id = $1 AND id <> $2 AND outcome IN ('complete', 'not_modified', 'suspicious')
      ORDER BY id DESC LIMIT $3`,
    [sourceId, snapshotId, graceSnapshots],
  );
  return rows.length === graceSnapshots && rows.every((row) => row.outcome === "suspicious");
}

export type ReconcileResult =
  | { outcome: "complete"; expired: number }
  | { outcome: "suspicious"; reason: string; expired: 0 };

async function markComplete(db: Queryable, source: Source, total: number | null, etag: string | null) {
  await db.query(
    `UPDATE job_sources SET
       last_complete_snapshot_at = now(),
       last_listing_count = COALESCE($2, last_listing_count),
       checkpoint_etag = $3,
       baseline_established_at = COALESCE(baseline_established_at, now())
     WHERE id = $1`,
    [source.id, total, etag],
  );
}

/**
 * Applies a complete snapshot. Absence is counted here and nowhere else, and the
 * checkpoint advances in the same transaction, after the listings are committed.
 */
export async function reconcileSnapshot(
  db: Queryable,
  source: Source,
  snapshotId: string,
  total: number,
  etag: string | null,
  settings: FreshnessSettings,
): Promise<ReconcileResult> {
  const { rows: stamp } = await db.query(
    `SELECT reconciled_at FROM source_snapshots WHERE id = $1 FOR UPDATE`,
    [snapshotId],
  );
  if (stamp[0]?.reconciled_at) return { outcome: "complete", expired: 0 };

  const { rows: counts } = await db.query(
    `SELECT count(*)::int AS active,
            count(*) FILTER (WHERE missing_snapshots = 0 AND last_seen_snapshot_id IS DISTINCT FROM $2)::int AS newly_absent
       FROM source_listings WHERE source_id = $1 AND status = 'active'`,
    [source.id, snapshotId],
  );
  const reason = judgeSnapshot(
    { total, previousTotal: source.lastListingCount, activeBefore: counts[0].active, newlyAbsent: counts[0].newly_absent },
    settings.suspiciousDropRatio,
  );
  if (reason && !(await suspicionConfirmed(db, source.id, snapshotId, settings.graceSnapshots))) {
    return { outcome: "suspicious", reason, expired: 0 };
  }

  await db.query(
    `UPDATE source_listings SET last_verified_at = now() WHERE source_id = $1 AND last_seen_snapshot_id = $2`,
    [source.id, snapshotId],
  );
  await db.query(
    `UPDATE canonical_jobs c SET last_verified_at = now()
       FROM source_listings l
      WHERE l.canonical_job_id = c.id AND l.source_id = $1 AND l.last_seen_snapshot_id = $2`,
    [source.id, snapshotId],
  );
  await db.query(
    `UPDATE source_listings SET missing_snapshots = missing_snapshots + 1
      WHERE source_id = $1 AND status = 'active' AND last_seen_snapshot_id IS DISTINCT FROM $2`,
    [source.id, snapshotId],
  );
  const expired = await expireAbsent(db, source, settings.graceSnapshots);
  await markComplete(db, source, total, etag);
  await db.query(`UPDATE source_snapshots SET reconciled_at = now() WHERE id = $1`, [snapshotId]);
  return { outcome: "complete", expired };
}

/**
 * A 304 repeats the last complete snapshot. Listings present in it are verified,
 * and listings absent from it are absent again, otherwise a job that vanished just
 * before a board went quiet would never reach the grace limit.
 */
export async function reconcileNotModified(
  db: Queryable,
  source: Source,
  snapshotId: string,
  settings: FreshnessSettings,
): Promise<number> {
  const { rows: verified } = await db.query(
    `UPDATE source_listings
        SET last_seen_at = now(), last_verified_at = now(), last_seen_snapshot_id = $2
      WHERE source_id = $1 AND status = 'active' AND missing_snapshots = 0
      RETURNING canonical_job_id`,
    [source.id, snapshotId],
  );
  await db.query(
    `UPDATE canonical_jobs SET last_seen_at = now(), last_verified_at = now() WHERE id = ANY($1::bigint[])`,
    [verified.map((row) => row.canonical_job_id)],
  );
  await db.query(
    `UPDATE source_listings SET missing_snapshots = missing_snapshots + 1
      WHERE source_id = $1 AND status = 'active' AND missing_snapshots > 0`,
    [source.id],
  );
  const expired = await expireAbsent(db, source, settings.graceSnapshots);
  await markComplete(db, source, null, source.checkpointEtag);
  await db.query(`UPDATE source_snapshots SET reconciled_at = now() WHERE id = $1`, [snapshotId]);
  return expired;
}
