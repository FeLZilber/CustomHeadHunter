import { createHash } from "node:crypto";
import { retryTransient, type Pool, type Queryable } from "../db/pool";
import { FILTER_VERSION } from "../filter";
import { redact } from "../logger";
import { hashMatchConfig, type MatchConfig } from "../match/config";
import type { Profile } from "../profile/schema";

export const CHANNEL = "telegram";
const PLAN_LOCK_ID = 7_242_003;

/** What decides whether a job qualifies right now. */
export interface Relevance {
  profileId: string;
  profileHash: string;
  configHash: string;
  threshold: number;
}

export function buildRelevance(profile: Profile, config: MatchConfig): Relevance {
  return {
    profileId: profile.profileId,
    profileHash: profile.matchingHash,
    configHash: hashMatchConfig(config),
    threshold: profile.preferences.notificationThreshold,
  };
}

const epochKey = (relevance: Relevance) =>
  createHash("sha256")
    .update(JSON.stringify([relevance.profileHash, relevance.configHash, FILTER_VERSION, relevance.threshold]))
    .digest("hex");

/**
 * Jobs with a verdict for their present content under the present profile and
 * model. Takes $1 profile hash, $2 config hash, $3 filter version. A job that
 * changed since it was evaluated has no row here until it is evaluated again.
 */
const CURRENT_JOBS = `
  canonical_jobs c
  JOIN companies co ON co.id = c.company_id
  JOIN job_evaluations e ON e.canonical_job_id = c.id AND e.decision = 'eligible'
   AND e.profile_hash = $1 AND e.config_hash = $2 AND e.filter_version = $3
  JOIN source_listings l ON l.id = e.source_listing_id AND l.status = 'active' AND l.content_hash = e.content_hash
  JOIN match_results r ON r.canonical_job_id = c.id AND r.input_key = e.input_key`;

const currentParams = (relevance: Relevance) => [relevance.profileHash, relevance.configHash, FILTER_VERSION];

interface Epoch {
  id: string;
  startedAt: Date;
}

async function latestEpoch(db: Queryable, profileId: string): Promise<(Epoch & { key: string }) | null> {
  const { rows } = await db.query(
    `SELECT id, epoch_key, started_at FROM notification_epochs WHERE profile_id = $1 ORDER BY id DESC LIMIT 1`,
    [profileId],
  );
  return rows[0] ? { id: rows[0].id, key: rows[0].epoch_key, startedAt: rows[0].started_at } : null;
}

/** The first epoch reaches back to the start, so jobs seen before notifications were planned still count. */
async function ensureEpoch(db: Queryable, relevance: Relevance): Promise<Epoch> {
  const key = epochKey(relevance);
  const latest = await latestEpoch(db, relevance.profileId);
  if (latest?.key === key) return latest;
  const { rows } = await db.query(
    `INSERT INTO notification_epochs (profile_id, epoch_key, reason, started_at)
     VALUES ($1, $2, $3, ${latest ? "now()" : "'-infinity'"}) RETURNING id, started_at`,
    [relevance.profileId, key, latest ? "relevance_changed" : "initial"],
  );
  return { id: rows[0].id, startedAt: rows[0].started_at };
}

/** A forced rematch redefines relevance without changing any hash, so it must close the epoch itself. */
export async function startEpoch(db: Queryable, relevance: Relevance, reason: string): Promise<void> {
  await db.query(`INSERT INTO notification_epochs (profile_id, epoch_key, reason) VALUES ($1, $2, $3)`, [
    relevance.profileId,
    epochKey(relevance),
    reason,
  ]);
}

/**
 * Takes the newest event of each qualifying job, so a job that changed twice
 * before its first match produces one message. Events inside a source baseline
 * belong to its digest.
 */
async function planAlerts(db: Queryable, relevance: Relevance, epoch: Epoch): Promise<number> {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (c.id) c.id AS job_id, ev.id AS event_id, ev.event_type, ev.lifecycle_cycle, ev.revision, r.score
       FROM ${CURRENT_JOBS}
       JOIN job_events ev ON ev.canonical_job_id = c.id
      WHERE c.status = 'active' AND r.score >= $4 AND NOT ev.during_baseline AND ev.created_at >= $5
        AND (ev.event_type IN ('discovered', 'reopened') OR (ev.event_type = 'changed' AND ev.significant))
        AND NOT EXISTS (SELECT 1 FROM notifications n
                         WHERE n.profile_id = $6 AND n.channel = $7 AND n.canonical_job_id = c.id AND n.job_event_id >= ev.id)
      ORDER BY c.id, ev.id DESC`,
    [...currentParams(relevance), relevance.threshold, epoch.startedAt, relevance.profileId, CHANNEL],
  );
  let planned = 0;
  for (const row of rows) {
    await db.query(
      `UPDATE notifications SET status = 'suppressed', suppressed_reason = 'superseded_by_newer_event', updated_at = now()
        WHERE profile_id = $1 AND channel = $2 AND canonical_job_id = $3 AND status IN ('pending', 'retry')`,
      [relevance.profileId, CHANNEL, row.job_id],
    );
    const { rowCount } = await db.query(
      `INSERT INTO notifications (profile_id, channel, kind, event_key, canonical_job_id, job_event_id, score)
       VALUES ($1, $2, 'alert', $3, $4, $5, $6)
       ON CONFLICT (profile_id, channel, event_key) DO NOTHING`,
      [
        relevance.profileId,
        CHANNEL,
        `job:${row.job_id}:${row.event_type}:${row.lifecycle_cycle}:${row.revision}`,
        row.job_id,
        row.event_id,
        row.score,
      ],
    );
    planned += rowCount ?? 0;
  }
  return planned;
}

/**
 * True while a job found in the source's baseline still awaits a verdict: not evaluated under the present
 * profile and model, or eligible with neither a result nor an exhausted task. An eligible job waiting
 * outside the capped AI queue has no task at all, so an open task alone is not the test.
 */
const BASELINE_UNRESOLVED = `
  EXISTS (
    SELECT 1 FROM job_events ev
      JOIN source_listings l ON l.id = ev.source_listing_id
      JOIN canonical_jobs c ON c.id = ev.canonical_job_id
      LEFT JOIN job_evaluations e ON e.canonical_job_id = c.id
       AND e.profile_hash = $1 AND e.config_hash = $2 AND e.filter_version = $3
     WHERE l.source_id = s.id AND ev.during_baseline AND ev.event_type = 'discovered' AND c.status = 'active'
       AND (e.canonical_job_id IS NULL
            OR EXISTS (SELECT 1 FROM match_tasks t WHERE t.canonical_job_id = c.id AND t.status IN ('pending', 'claimed'))
            OR (e.decision = 'eligible'
                AND NOT EXISTS (SELECT 1 FROM match_results r WHERE r.canonical_job_id = c.id AND r.input_key = e.input_key)
                AND NOT EXISTS (SELECT 1 FROM match_tasks t
                                 WHERE t.canonical_job_id = c.id AND t.input_key = e.input_key AND t.status = 'exhausted'))))`;

/**
 * Baseline jobs never alert one by one. While a source's baseline is still being judged, each run sends
 * one capped digest of the jobs that qualified since the last one: the AI queue is ranked, so the likeliest
 * jobs are judged first and reach the owner the same day, not after the last unlikely one. When every
 * baseline job has a verdict, a closing row is written under the source's own key. It is the last digest,
 * or a suppressed marker, and it stops a later rematch from raising a digest for an old source.
 * A job is never listed twice: one already named in any notification is left out.
 */
async function planBaselineDigests(db: Queryable, relevance: Relevance, digestSize: number): Promise<number> {
  const { rows: sources } = await db.query(
    `SELECT s.id, ${BASELINE_UNRESOLVED} AS unresolved
       FROM job_sources s
      WHERE s.baseline_established_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM notifications n
                         WHERE n.profile_id = $4 AND n.channel = $5 AND n.event_key = 'baseline:source:' || s.id)`,
    [...currentParams(relevance), relevance.profileId, CHANNEL],
  );
  let planned = 0;
  for (const source of sources) {
    const { rows: jobs } = await db.query(
      `SELECT DISTINCT c.id, r.score
         FROM ${CURRENT_JOBS}
         JOIN job_events ev ON ev.canonical_job_id = c.id AND ev.during_baseline AND ev.event_type = 'discovered'
         JOIN source_listings origin ON origin.id = ev.source_listing_id AND origin.source_id = $4
        WHERE c.status = 'active' AND r.score >= $5
          AND NOT EXISTS (SELECT 1 FROM notifications n
                           WHERE n.profile_id = $6 AND n.channel = $7
                             AND (n.canonical_job_id = c.id OR c.id = ANY (n.job_ids)))
        ORDER BY r.score DESC, c.id`,
      [...currentParams(relevance), source.id, relevance.threshold, relevance.profileId, CHANNEL],
    );
    const members = jobs.slice(0, digestSize);
    if (source.unresolved && members.length === 0) continue;

    let key = `baseline:source:${source.id}`;
    let suppressedReason: string | null = null;
    if (source.unresolved) {
      // No job in this batch was ever in a notification, so its first id names the batch uniquely.
      key = `${key}:batch:${members[0].id}`;
    } else if (members.length === 0) {
      const { rowCount } = await db.query(
        `SELECT 1 FROM notifications WHERE profile_id = $1 AND channel = $2 AND source_id = $3 AND event_key LIKE 'baseline:source:%' LIMIT 1`,
        [relevance.profileId, CHANNEL, source.id],
      );
      suppressedReason = rowCount ? "delivered_in_batches" : "no_qualifying_jobs";
    }
    const { rowCount } = await db.query(
      `INSERT INTO notifications (profile_id, channel, kind, event_key, source_id, job_ids, more_count, score,
                                  status, suppressed_reason)
       VALUES ($1, $2, 'digest', $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (profile_id, channel, event_key) DO NOTHING`,
      [
        relevance.profileId,
        CHANNEL,
        key,
        source.id,
        members.map((job) => job.id),
        jobs.length - members.length,
        members[0]?.score ?? null,
        members.length ? "pending" : "suppressed",
        suppressedReason,
      ],
    );
    if (members.length) planned += rowCount ?? 0;
  }
  return planned;
}

export interface PlanSummary {
  alerts: number;
  digests: number;
}

/** Derives messages from committed results in one transaction. Replaying it adds nothing. */
export async function planNotifications(db: Queryable, relevance: Relevance, digestSize: number): Promise<PlanSummary> {
  await db.query(`SELECT pg_advisory_xact_lock($1)`, [PLAN_LOCK_ID]);
  const epoch = await ensureEpoch(db, relevance);
  return {
    alerts: await planAlerts(db, relevance, epoch),
    digests: await planBaselineDigests(db, relevance, digestSize),
  };
}

/** Opt-in, and at most once per epoch: old jobs that qualify after a profile or model change, never yet delivered. */
export async function planRematchDigest(db: Queryable, relevance: Relevance, digestSize: number): Promise<number> {
  await db.query(`SELECT pg_advisory_xact_lock($1)`, [PLAN_LOCK_ID]);
  const epoch = await ensureEpoch(db, relevance);
  const { rows: jobs } = await db.query(
    `SELECT c.id, r.score
       FROM ${CURRENT_JOBS}
      WHERE c.status = 'active' AND r.score >= $4
        AND NOT EXISTS (SELECT 1 FROM notifications n
                         WHERE n.profile_id = $5 AND n.channel = $6 AND n.status = 'sent'
                           AND (n.canonical_job_id = c.id OR c.id = ANY (n.job_ids)))
      ORDER BY r.score DESC, c.id`,
    [...currentParams(relevance), relevance.threshold, relevance.profileId, CHANNEL],
  );
  if (jobs.length === 0) return 0;
  const members = jobs.slice(0, digestSize);
  const { rowCount } = await db.query(
    `INSERT INTO notifications (profile_id, channel, kind, event_key, job_ids, more_count, score)
     VALUES ($1, $2, 'digest', $3, $4, $5, $6)
     ON CONFLICT (profile_id, channel, event_key) DO NOTHING`,
    [
      relevance.profileId,
      CHANNEL,
      `rematch:epoch:${epoch.id}`,
      members.map((job) => job.id),
      jobs.length - members.length,
      members[0].score,
    ],
  );
  return rowCount ?? 0;
}

export type NotificationKind = "alert" | "digest";

export interface Notification {
  id: string;
  kind: NotificationKind;
  eventKey: string;
  canonicalJobId: string | null;
  jobEventId: string | null;
  jobIds: string[];
  moreCount: number;
  attempts: number;
}

function toNotification(row: Record<string, any>): Notification {
  return {
    id: row.id,
    kind: row.kind,
    eventKey: row.event_key,
    canonicalJobId: row.canonical_job_id,
    jobEventId: row.job_event_id,
    jobIds: row.job_ids,
    moreCount: row.more_count,
    attempts: row.attempts,
  };
}

const DUE = `status IN ('pending', 'retry') AND next_attempt_at <= now()`;

export async function listDue(db: Queryable, profileId: string, kind: NotificationKind, limit: number): Promise<Notification[]> {
  const { rows } = await db.query(
    `SELECT * FROM notifications WHERE profile_id = $1 AND kind = $2 AND channel = $3 AND ${DUE}
      ORDER BY score DESC NULLS LAST, id LIMIT $4`,
    [profileId, kind, CHANNEL, limit],
  );
  return rows.map(toNotification);
}

export async function claimNotification(
  pool: Pool,
  profileId: string,
  kind: NotificationKind,
  owner: string,
  leaseSeconds: number,
): Promise<Notification | null> {
  const { rows } = await retryTransient(() =>
    pool.query(
      `UPDATE notifications SET status = 'claimed', lease_owner = $1, lease_until = now() + make_interval(secs => $2),
              send_started_at = NULL, updated_at = now()
        WHERE id = (SELECT id FROM notifications
                     WHERE profile_id = $3 AND kind = $4 AND channel = $5 AND ${DUE}
                     ORDER BY score DESC NULLS LAST, id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [owner, leaseSeconds, profileId, kind, CHANNEL],
    ),
  );
  return rows[0] ? toNotification(rows[0]) : null;
}

/** Must commit before the request. From here on a lost claim means "may have been delivered". */
export async function markSending(pool: Pool, id: string, owner: string): Promise<boolean> {
  const { rowCount } = await retryTransient(() =>
    pool.query(
      `UPDATE notifications SET send_started_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'claimed' AND lease_owner = $2`,
      [id, owner],
    ),
  );
  return rowCount === 1;
}

/** Recorded even from `ambiguous`, because an acknowledgement settles what a lapsed lease only guessed. */
export async function markSent(pool: Pool, id: string, messageId: string, inputKey: string | null, jobIds: string[]): Promise<void> {
  await retryTransient(() =>
    pool.query(
      `UPDATE notifications SET status = 'sent', message_id = $2, sent_input_key = $3, job_ids = $4, sent_at = now(),
              lease_owner = NULL, lease_until = NULL, last_error_kind = NULL, last_error = NULL, updated_at = now()
        WHERE id = $1 AND status IN ('claimed', 'ambiguous')`,
      [id, messageId, inputKey, jobIds],
    ),
  );
}

async function settle(pool: Pool, id: string, owner: string, fields: string, values: unknown[]): Promise<void> {
  await retryTransient(() =>
    pool.query(
      `UPDATE notifications SET ${fields}, lease_owner = NULL, lease_until = NULL, updated_at = now()
        WHERE id = $1 AND status = 'claimed' AND lease_owner = $2`,
      [id, owner, ...values],
    ),
  );
}

export const suppressNotification = (pool: Pool, id: string, owner: string, reason: string) =>
  settle(pool, id, owner, `status = 'suppressed', suppressed_reason = $3`, [reason]);

/** Waiting on a verdict is not a delivery failure, so it spends no attempt. */
export const deferNotification = (pool: Pool, id: string, owner: string, delaySeconds: number) =>
  settle(pool, id, owner, `status = 'pending', next_attempt_at = now() + make_interval(secs => $3)`, [delaySeconds]);

/** Telegram did not take the message, so nothing was delivered. */
export const retryNotification = (pool: Pool, id: string, owner: string, delaySeconds: number, kind: string, message: string, countsAsAttempt: boolean) =>
  settle(
    pool,
    id,
    owner,
    `status = 'retry', attempts = attempts + $3, next_attempt_at = now() + make_interval(secs => $4),
     last_error_kind = $5, last_error = $6`,
    [countsAsAttempt ? 1 : 0, delaySeconds, kind, redact(message).slice(0, 500)],
  );

export const failNotification = (pool: Pool, id: string, owner: string, kind: string, message: string) =>
  settle(pool, id, owner, `status = 'failed', attempts = attempts + 1, last_error_kind = $3, last_error = $4`, [
    kind,
    redact(message).slice(0, 500),
  ]);

export const markAmbiguous = (pool: Pool, id: string, owner: string, message: string) =>
  settle(pool, id, owner, `status = 'ambiguous', attempts = attempts + 1, last_error_kind = 'ambiguous', last_error = $3`, [
    redact(message).slice(0, 500),
  ]);

/**
 * Returns lapsed claims. One that never began sending goes back in the queue,
 * and one that did cannot be proved undelivered, so it waits for the operator.
 */
export async function recoverNotificationClaims(pool: Pool): Promise<{ released: number; ambiguous: number }> {
  const { rows } = await retryTransient(() =>
    pool.query(
      `UPDATE notifications
          SET status = CASE WHEN send_started_at IS NULL THEN 'pending' ELSE 'ambiguous' END,
              last_error_kind = CASE WHEN send_started_at IS NULL THEN last_error_kind ELSE 'ambiguous' END,
              last_error = CASE WHEN send_started_at IS NULL THEN last_error ELSE 'Worker stopped during delivery' END,
              lease_owner = NULL, lease_until = NULL, updated_at = now()
        WHERE status = 'claimed' AND lease_until < now()
        RETURNING status`,
    ),
  );
  return {
    released: rows.filter((row) => row.status === "pending").length,
    ambiguous: rows.filter((row) => row.status === "ambiguous").length,
  };
}

/** Operator action, taken after checking the chat. Resending an ambiguous message can duplicate it. */
export async function reopenNotifications(pool: Pool, statuses: Array<"ambiguous" | "failed">): Promise<number> {
  const { rowCount } = await retryTransient(() =>
    pool.query(
      `UPDATE notifications SET status = 'pending', attempts = 0, next_attempt_at = now(), send_started_at = NULL, updated_at = now()
        WHERE status = ANY ($1::text[])`,
      [statuses],
    ),
  );
  return rowCount ?? 0;
}

export interface CurrentJob {
  id: string;
  title: string;
  company: string;
  location: string | null;
  score: number;
  inputKey: string;
  technologies: Array<{ name: string; level: string }>;
  response: Record<string, any>;
  evidenceUnverified: string[];
  discoveredAt: Date;
  applicationUrl: string;
}

/** Best first, so a digest reads in score order whatever order it was planned in. */
export async function loadCurrentJobs(db: Queryable, jobIds: string[], relevance: Relevance): Promise<CurrentJob[]> {
  const { rows } = await db.query(
    `SELECT c.id, l.title, co.name AS company, l.original_location, r.score, r.input_key, l.technologies, r.response,
            r.evidence_unverified, c.first_discovered_at, l.application_url
       FROM ${CURRENT_JOBS}
      WHERE c.id = ANY ($4::bigint[]) AND c.status = 'active'
      ORDER BY r.score DESC, c.id`,
    [...currentParams(relevance), jobIds],
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    company: row.company,
    location: row.original_location,
    score: row.score,
    inputKey: row.input_key,
    technologies: row.technologies,
    response: row.response,
    evidenceUnverified: row.evidence_unverified,
    discoveredAt: row.first_discovered_at,
    applicationUrl: row.application_url,
  }));
}

/** Why a job with no current verdict has none. `pending` means one is on the way. */
export async function explainMissingVerdict(
  db: Queryable,
  jobId: string,
  relevance: Relevance,
): Promise<"inactive" | "pending" | "none"> {
  const { rows } = await db.query(
    `SELECT c.status,
            EXISTS (SELECT 1 FROM match_tasks t WHERE t.canonical_job_id = c.id AND t.status IN ('pending', 'claimed')) AS open_task,
            e.canonical_job_id IS NOT NULL AND e.profile_hash = $2 AND e.config_hash = $3 AND e.filter_version = $4
              AND l.content_hash IS NOT DISTINCT FROM e.content_hash AS evaluated
       FROM canonical_jobs c
       LEFT JOIN job_evaluations e ON e.canonical_job_id = c.id
       LEFT JOIN source_listings l ON l.id = e.source_listing_id
      WHERE c.id = $1`,
    [jobId, ...currentParams(relevance)],
  );
  const row = rows[0];
  if (!row || row.status !== "active") return "inactive";
  return row.open_task || !row.evaluated ? "pending" : "none";
}

export async function jobEventType(db: Queryable, jobEventId: string): Promise<string> {
  const { rows } = await db.query(`SELECT event_type FROM job_events WHERE id = $1`, [jobEventId]);
  return rows[0].event_type;
}

export async function readOutbox(db: Queryable): Promise<Record<string, number>> {
  const { rows } = await db.query(`SELECT status, count(*)::int AS n FROM notifications GROUP BY status`);
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}
