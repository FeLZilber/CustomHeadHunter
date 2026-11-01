import type { Queryable } from "../db/pool";
import {
  changedFields,
  matchingFields,
  NORMALIZATION_VERSION,
  type NormalizedListing,
} from "../normalize";
import type { Source } from "./sources";

export interface PersistContext {
  source: Source;
  snapshotId: string;
  significantFields: string[];
}

export type ListingChange = "new" | "changed" | "unchanged";

interface EventInput {
  canonicalJobId: string;
  sourceListingId: string | null;
  type: "discovered" | "changed" | "expired" | "reopened";
  cycle: number;
  revision: number;
  significant: boolean;
  duringBaseline: boolean;
  changedFields?: string[];
  contentHash: string;
}

/** The unique key makes a replayed lifecycle step a no-op rather than a second event. */
export async function recordEvent(db: Queryable, event: EventInput): Promise<void> {
  await db.query(
    `INSERT INTO job_events (canonical_job_id, source_listing_id, event_type, lifecycle_cycle, revision,
                             significant, during_baseline, changed_fields, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (canonical_job_id, event_type, lifecycle_cycle, revision) DO NOTHING`,
    [
      event.canonicalJobId,
      event.sourceListingId,
      event.type,
      event.cycle,
      event.revision,
      event.significant,
      event.duringBaseline,
      event.changedFields ?? [],
      event.contentHash,
    ],
  );
}

const PLACEHOLDER_REQUISITION = /^(?:n\/?a|none|null|tbd|tba|-+|0+)$/i;

const usableRequisition = (id: string | null): string | null =>
  id && id.length >= 3 && !PLACEHOLDER_REQUISITION.test(id) ? id : null;

/**
 * Finds the canonical job this listing duplicates on another source of the same
 * company. Only a requisition id or canonical URL counts, and an ambiguous match
 * stays separate. Within one source, the provider job id alone is identity.
 */
async function findCanonicalMatch(db: Queryable, source: Source, listing: NormalizedListing): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT DISTINCT l.canonical_job_id
       FROM source_listings l JOIN job_sources s ON s.id = l.source_id
      WHERE s.company_id = $1 AND l.source_id <> $2
        AND (l.canonical_url = $3 OR ($4::text IS NOT NULL AND l.requisition_id = $4))
      LIMIT 2`,
    [source.companyId, source.id, listing.canonicalUrl, usableRequisition(listing.requisitionId)],
  );
  return rows.length === 1 ? rows[0].canonical_job_id : null;
}

async function reopenCanonical(db: Queryable, context: PersistContext, canonicalId: string, listingId: string) {
  const { rows } = await db.query(
    `UPDATE canonical_jobs
        SET status = 'active', lifecycle_cycle = lifecycle_cycle + 1, status_changed_at = now()
      WHERE id = $1 AND status = 'expired'
      RETURNING lifecycle_cycle, revision, content_hash`,
    [canonicalId],
  );
  const reopened = rows[0];
  if (!reopened) return;
  await recordEvent(db, {
    canonicalJobId: canonicalId,
    sourceListingId: listingId,
    type: "reopened",
    cycle: reopened.lifecycle_cycle,
    revision: reopened.revision,
    significant: true,
    duringBaseline: !context.source.baselineEstablished,
    contentHash: reopened.content_hash,
  });
}

function listingValues(listing: NormalizedListing): unknown[] {
  return [
    listing.requisitionId,
    listing.title,
    listing.originalDescription,
    listing.descriptionText,
    listing.originalLocation,
    JSON.stringify(listing.locations),
    listing.workArrangement,
    listing.remoteScope,
    listing.employmentType,
    listing.seniority,
    JSON.stringify(listing.technologies),
    listing.experience ? JSON.stringify(listing.experience) : null,
    listing.salary ? JSON.stringify(listing.salary) : null,
    listing.applicationUrl,
    listing.canonicalUrl,
    listing.publishedAt,
    listing.providerUpdatedAt,
    listing.contentHash,
    NORMALIZATION_VERSION,
  ];
}

async function insertListing(db: Queryable, context: PersistContext, listing: NormalizedListing): Promise<void> {
  const { source, snapshotId } = context;
  const matched = await findCanonicalMatch(db, source, listing);
  const canonicalId: string =
    matched ??
    (
      await db.query(
        `INSERT INTO canonical_jobs (company_id, title, content_hash) VALUES ($1, $2, $3) RETURNING id`,
        [source.companyId, listing.title, listing.contentHash],
      )
    ).rows[0].id;

  const { rows } = await db.query(
    `INSERT INTO source_listings (requisition_id, title, original_description, description_text, original_location,
       normalized_locations, work_arrangement, remote_scope, employment_type, seniority, technologies, experience,
       salary, application_url, canonical_url, published_at, provider_updated_at, content_hash, normalization_version,
       source_id, provider_job_id, canonical_job_id, last_seen_snapshot_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
     RETURNING id`,
    [...listingValues(listing), source.id, listing.providerJobId, canonicalId, snapshotId],
  );
  const listingId: string = rows[0].id;

  if (matched) {
    await reopenCanonical(db, context, canonicalId, listingId);
    await db.query(`UPDATE canonical_jobs SET last_seen_at = now() WHERE id = $1`, [canonicalId]);
    return;
  }
  await recordEvent(db, {
    canonicalJobId: canonicalId,
    sourceListingId: listingId,
    type: "discovered",
    cycle: 1,
    revision: 1,
    significant: true,
    duringBaseline: !source.baselineEstablished,
    contentHash: listing.contentHash,
  });
}

function storedMatchingFields(row: Record<string, any>) {
  return matchingFields({
    title: row.title,
    descriptionText: row.description_text,
    locations: row.normalized_locations,
    workArrangement: row.work_arrangement,
    remoteScope: row.remote_scope,
    employmentType: row.employment_type,
    seniority: row.seniority,
    technologies: row.technologies,
    experience: row.experience,
    salary: row.salary,
  });
}

/** Writes one listing. Observation alone never verifies it; that needs a complete snapshot. */
export async function upsertListing(
  db: Queryable,
  context: PersistContext,
  listing: NormalizedListing,
): Promise<ListingChange> {
  const { source, snapshotId, significantFields } = context;
  const { rows } = await db.query(
    `SELECT * FROM source_listings WHERE source_id = $1 AND provider_job_id = $2 FOR UPDATE`,
    [source.id, listing.providerJobId],
  );
  const existing = rows[0];
  if (!existing) {
    await insertListing(db, context, listing);
    return "new";
  }

  // Most crawls see the same text again. Rewriting it would churn TOAST storage on a 1 GB plan.
  const sameContent =
    existing.content_hash === listing.contentHash &&
    existing.normalization_version === NORMALIZATION_VERSION &&
    existing.original_description === listing.originalDescription &&
    existing.application_url === listing.applicationUrl &&
    existing.provider_updated_at?.getTime() === listing.providerUpdatedAt?.getTime();

  if (sameContent) {
    await db.query(
      `UPDATE source_listings SET
         status = 'active', missing_snapshots = 0, last_seen_snapshot_id = $1, last_seen_at = now(),
         status_changed_at = CASE WHEN status = 'expired' THEN now() ELSE status_changed_at END
       WHERE id = $2`,
      [snapshotId, existing.id],
    );
  } else {
    await db.query(
      `UPDATE source_listings SET
         requisition_id = $1, title = $2, original_description = $3, description_text = $4, original_location = $5,
       normalized_locations = $6, work_arrangement = $7, remote_scope = $8, employment_type = $9, seniority = $10,
       technologies = $11, experience = $12, salary = $13, application_url = $14, canonical_url = $15,
       published_at = $16, provider_updated_at = $17, content_hash = $18, normalization_version = $19,
       status = 'active', missing_snapshots = 0, last_seen_snapshot_id = $20, last_seen_at = now(),
       status_changed_at = CASE WHEN status = 'expired' THEN now() ELSE status_changed_at END
     WHERE id = $21`,
      [...listingValues(listing), snapshotId, existing.id],
    );
  }

  const canonicalId: string = existing.canonical_job_id;
  if (existing.status === "expired") await reopenCanonical(db, context, canonicalId, existing.id);

  const changed = existing.content_hash !== listing.contentHash;
  if (!changed) {
    await db.query(`UPDATE canonical_jobs SET last_seen_at = now() WHERE id = $1`, [canonicalId]);
    return "unchanged";
  }

  const fields = changedFields(storedMatchingFields(existing), matchingFields(listing));
  const { rows: canonical } = await db.query(
    `UPDATE canonical_jobs SET revision = revision + 1, content_hash = $2, title = $3, last_seen_at = now()
      WHERE id = $1 RETURNING lifecycle_cycle, revision`,
    [canonicalId, listing.contentHash, listing.title],
  );
  await recordEvent(db, {
    canonicalJobId: canonicalId,
    sourceListingId: existing.id,
    type: "changed",
    cycle: canonical[0].lifecycle_cycle,
    revision: canonical[0].revision,
    // A new normalizer re-derives fields for every job; that is not news about the job.
    significant:
      existing.normalization_version === NORMALIZATION_VERSION &&
      fields.some((field) => significantFields.includes(field)),
    duringBaseline: !source.baselineEstablished,
    changedFields: fields,
    contentHash: listing.contentHash,
  });
  return "changed";
}
