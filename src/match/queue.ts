import { DEFAULT_AI_QUEUE_LIMIT } from "../config/budget";
import { retryTransient, withTransaction, type Pool, type Queryable } from "../db/pool";
import { applyFilter, FILTER_VERSION, type FilterResult } from "../filter";
import { redact } from "../logger";
import type { MatchingProfile, Profile } from "../profile/schema";
import { OWNER_KEY } from "../profile/store";
import { buildInputKey, hashMatchConfig, type MatchConfig } from "./config";
import type { JobFacts } from "./facts";
import type { EvidenceCheck, JobInput } from "./prompt";
import type { MatchResponse } from "./schema";

const EVALUATION_BATCH = 100;
const EVALUATION_LOCK_ID = 7_242_002;

export interface EvaluationSummary {
  evaluated: number;
  eligible: number;
  rejected: number;
  /** Tasks this run really added to the queue. */
  queued: number;
  /** Eligible, unscored and not queued: ranked below the queue limit and waiting for room. */
  deferred: number;
  reused: number;
}

interface Hashes {
  profileHash: string;
  configHash: string;
}

/** Selects active jobs whose verdict no longer reflects their inputs. */
async function selectStale(db: Queryable, { profileHash, configHash }: Hashes) {
  const { rows } = await db.query(
    `SELECT c.id AS canonical_job_id, l.id AS listing_id, l.title, l.description_text, l.seniority, l.employment_type,
            l.technologies, l.experience, l.normalized_locations, l.remote_scope, l.content_hash
       FROM canonical_jobs c
       CROSS JOIN LATERAL (
         SELECT * FROM source_listings s WHERE s.canonical_job_id = c.id AND s.status = 'active' ORDER BY s.id LIMIT 1
       ) l
       LEFT JOIN job_evaluations e ON e.canonical_job_id = c.id
      WHERE c.status = 'active'
        AND (e.canonical_job_id IS NULL OR e.source_listing_id <> l.id OR e.content_hash <> l.content_hash
             OR e.profile_hash <> $1 OR e.config_hash <> $2 OR e.filter_version <> $3)
      ORDER BY c.id
      LIMIT $4`,
    [profileHash, configHash, FILTER_VERSION, EVALUATION_BATCH],
  );
  return rows;
}

function decide(row: Record<string, any>, matching: MatchingProfile): FilterResult {
  return applyFilter(
    {
      title: row.title,
      descriptionText: row.description_text,
      seniority: row.seniority,
      employmentType: row.employment_type,
      technologies: row.technologies,
      experience: row.experience,
      locations: row.normalized_locations,
      remoteScope: row.remote_scope,
    },
    matching,
  );
}

async function supersedeOpenTasks(db: Queryable, jobId: string, keepKey: string | null) {
  await db.query(
    `UPDATE match_tasks SET status = 'superseded', lease_owner = NULL, lease_until = NULL, updated_at = now()
      WHERE canonical_job_id = $1 AND status IN ('pending', 'claimed') AND input_key IS DISTINCT FROM $2`,
    [jobId, keepKey],
  );
}

/** Exhausted work stays exhausted until an operator retries it; only superseded work may reopen. */
async function queueTask(db: Queryable, row: Record<string, any>, profile: Profile, hashes: Hashes, key: string, priority: number) {
  await db.query(
    `INSERT INTO match_tasks (canonical_job_id, source_listing_id, input_key, content_hash, profile_revision_id,
                              profile_hash, config_hash, priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (canonical_job_id, input_key) DO UPDATE
       SET status = CASE WHEN match_tasks.status = 'superseded' THEN 'pending' ELSE match_tasks.status END,
           attempts = CASE WHEN match_tasks.status = 'superseded' THEN 0 ELSE match_tasks.attempts END,
           next_attempt_at = CASE WHEN match_tasks.status = 'superseded' THEN now() ELSE match_tasks.next_attempt_at END,
           source_listing_id = EXCLUDED.source_listing_id,
           profile_revision_id = EXCLUDED.profile_revision_id,
           priority = EXCLUDED.priority,
           updated_at = now()`,
    [row.canonical_job_id, row.listing_id, key, row.content_hash, profile.revisionId, hashes.profileHash, hashes.configHash, priority],
  );
}

async function evaluateBatch(db: Queryable, profile: Profile, hashes: Hashes): Promise<EvaluationSummary> {
  await db.query(`SELECT pg_advisory_xact_lock($1)`, [EVALUATION_LOCK_ID]);
  const summary: EvaluationSummary = { evaluated: 0, eligible: 0, rejected: 0, queued: 0, deferred: 0, reused: 0 };
  for (const row of await selectStale(db, hashes)) {
    const result = decide(row, profile.matching);
    const key = result.decision === "eligible" ? buildInputKey(row.content_hash, hashes.profileHash, hashes.configHash) : null;
    await supersedeOpenTasks(db, row.canonical_job_id, key);
    if (key) {
      const { rowCount } = await db.query(`SELECT 1 FROM match_results WHERE canonical_job_id = $1 AND input_key = $2`, [
        row.canonical_job_id,
        key,
      ]);
      if (rowCount) summary.reused += 1;
    }
    await db.query(
      `INSERT INTO job_evaluations (canonical_job_id, source_listing_id, profile_revision_id, profile_hash, filter_version,
                                    config_hash, content_hash, decision, reason_codes, input_key, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (canonical_job_id) DO UPDATE
         SET source_listing_id = EXCLUDED.source_listing_id, profile_revision_id = EXCLUDED.profile_revision_id,
             profile_hash = EXCLUDED.profile_hash, filter_version = EXCLUDED.filter_version,
             config_hash = EXCLUDED.config_hash, content_hash = EXCLUDED.content_hash, decision = EXCLUDED.decision,
             reason_codes = EXCLUDED.reason_codes, input_key = EXCLUDED.input_key, priority = EXCLUDED.priority,
             evaluated_at = now()`,
      [row.canonical_job_id, row.listing_id, profile.revisionId, hashes.profileHash, FILTER_VERSION, hashes.configHash,
       row.content_hash, result.decision, result.reasons, key, result.priority],
    );
    summary.evaluated += 1;
    summary[result.decision === "eligible" ? "eligible" : "rejected"] += 1;
  }
  return summary;
}

/**
 * Tops the queue up with the best-ranked eligible jobs that have no answer and no
 * task yet. Ranking is the deterministic priority stored at evaluation, so a deep
 * catalog never turns into a deep model backlog. Exhausted and succeeded tasks are
 * left alone; only a superseded one reopens (inside queueTask).
 */
async function fillQueue(db: Queryable, profile: Profile, hashes: Hashes, limit: number): Promise<{ queued: number; deferred: number }> {
  await db.query(`SELECT pg_advisory_xact_lock($1)`, [EVALUATION_LOCK_ID]);
  // Only tasks that can still run take a slot. A pending task whose job closed, whose posting
  // changed or whose profile was replaced is never claimed, and counting it would starve the queue.
  const { rows: open } = await db.query(
    `SELECT count(*)::int AS n FROM match_tasks t
      WHERE t.status IN ('pending', 'claimed') AND t.config_hash = $1 AND t.profile_hash = $2
        AND EXISTS (SELECT 1 FROM canonical_jobs c WHERE c.id = t.canonical_job_id AND c.status = 'active')
        AND EXISTS (SELECT 1 FROM job_evaluations e WHERE e.canonical_job_id = t.canonical_job_id AND e.input_key = t.input_key)
        AND EXISTS (SELECT 1 FROM source_listings l WHERE l.id = t.source_listing_id AND l.status = 'active'
                     AND l.content_hash = t.content_hash)`,
    [hashes.configHash, hashes.profileHash],
  );
  const room = Math.max(0, limit - open[0].n);
  const unqueued = `
      FROM job_evaluations e
      JOIN canonical_jobs c ON c.id = e.canonical_job_id AND c.status = 'active'
      JOIN source_listings l ON l.id = e.source_listing_id AND l.status = 'active' AND l.content_hash = e.content_hash
     WHERE e.decision = 'eligible' AND e.input_key IS NOT NULL
       AND e.profile_hash = $1 AND e.config_hash = $2 AND e.filter_version = $3
       AND NOT EXISTS (SELECT 1 FROM match_results r WHERE r.canonical_job_id = e.canonical_job_id AND r.input_key = e.input_key)
       AND NOT EXISTS (SELECT 1 FROM match_tasks t WHERE t.canonical_job_id = e.canonical_job_id AND t.input_key = e.input_key
                        AND t.status <> 'superseded')`;
  const params = [hashes.profileHash, hashes.configHash, FILTER_VERSION];
  let queued = 0;
  if (room > 0) {
    const { rows } = await db.query(
      `SELECT e.canonical_job_id, l.id AS listing_id, l.content_hash, e.input_key, e.priority ${unqueued}
        ORDER BY e.priority DESC, l.published_at DESC NULLS LAST, e.canonical_job_id DESC
        LIMIT $4`,
      [...params, room],
    );
    for (const row of rows) await queueTask(db, row, profile, hashes, row.input_key, row.priority);
    queued = rows.length;
  }
  const { rows: left } = await db.query(`SELECT count(*)::int AS n ${unqueued}`, params);
  return { queued, deferred: left[0].n };
}

/**
 * Runs the deterministic stage. It commits batch by batch and spends no model time.
 * `queueLimit` caps open model tasks; 0 queues nothing.
 */
export async function evaluateJobs(
  pool: Pool,
  config: MatchConfig,
  profile: Profile,
  queueLimit: number = DEFAULT_AI_QUEUE_LIMIT,
): Promise<EvaluationSummary> {
  const hashes = { profileHash: profile.matchingHash, configHash: hashMatchConfig(config) };
  const total: EvaluationSummary = { evaluated: 0, eligible: 0, rejected: 0, queued: 0, deferred: 0, reused: 0 };
  for (;;) {
    const batch = await withTransaction(pool, (client) => evaluateBatch(client, profile, hashes));
    for (const key of Object.keys(total) as Array<keyof EvaluationSummary>) total[key] += batch[key];
    if (batch.evaluated < EVALUATION_BATCH) break;
  }
  const filled = await withTransaction(pool, (client) => fillQueue(client, profile, hashes, queueLimit));
  total.queued = filled.queued;
  total.deferred = filled.deferred;
  return total;
}

/** A task is runnable only while it is still the question this job needs answered. */
const RUNNABLE = `
  t.status = 'pending' AND t.config_hash = $1
  AND EXISTS (SELECT 1 FROM canonical_jobs c WHERE c.id = t.canonical_job_id AND c.status = 'active')
  AND EXISTS (SELECT 1 FROM job_evaluations e WHERE e.canonical_job_id = t.canonical_job_id AND e.input_key = t.input_key)
  AND EXISTS (SELECT 1 FROM source_listings l WHERE l.id = t.source_listing_id AND l.status = 'active' AND l.content_hash = t.content_hash)
  AND EXISTS (SELECT 1 FROM profiles p JOIN profile_revisions r ON r.id = p.current_revision_id
               WHERE p.owner_key = '${OWNER_KEY}' AND r.matching_hash = t.profile_hash)`;

export interface MatchTask {
  id: string;
  canonicalJobId: string;
  inputKey: string;
  contentHash: string;
  profileRevisionId: string;
  attempts: number;
  matching: MatchingProfile;
  job: { title: string; company: string; location: string | null; description: string };
  facts: JobFacts;
}

/** Claims first and reads the job afterwards, so a skipped row costs no description transfer. */
export async function claimTask(pool: Pool, config: MatchConfig, owner: string, leaseSeconds: number): Promise<MatchTask | null> {
  const { rows } = await retryTransient(() =>
    pool.query(
      `UPDATE match_tasks SET status = 'claimed', attempts = attempts + 1, lease_owner = $2,
              lease_until = now() + make_interval(secs => $3), updated_at = now()
        WHERE id = (SELECT t.id FROM match_tasks t JOIN source_listings posting ON posting.id = t.source_listing_id
                     WHERE ${RUNNABLE} AND t.next_attempt_at <= now()
                     ORDER BY t.priority DESC, posting.published_at DESC NULLS LAST, t.id DESC
                     LIMIT 1 FOR UPDATE OF t SKIP LOCKED)
        RETURNING id`,
      [hashMatchConfig(config), owner, leaseSeconds],
    ),
  );
  if (!rows[0]) return null;
  const { rows: details } = await retryTransient(() =>
    pool.query(
      `SELECT t.id, t.canonical_job_id, t.input_key, t.content_hash, t.profile_revision_id, t.attempts, r.matching,
              l.title, l.description_text, l.original_location, co.name AS company, co.industry,
              l.seniority, l.technologies, l.experience, l.normalized_locations, l.remote_scope
         FROM match_tasks t
         JOIN profile_revisions r ON r.id = t.profile_revision_id
         JOIN source_listings l ON l.id = t.source_listing_id
         JOIN canonical_jobs c ON c.id = t.canonical_job_id
         JOIN companies co ON co.id = c.company_id
        WHERE t.id = $1`,
      [rows[0].id],
    ),
  );
  const row = details[0];
  return {
    id: row.id,
    canonicalJobId: row.canonical_job_id,
    inputKey: row.input_key,
    contentHash: row.content_hash,
    profileRevisionId: row.profile_revision_id,
    attempts: row.attempts,
    matching: row.matching,
    job: { title: row.title, company: row.company, location: row.original_location, description: row.description_text },
    facts: {
      seniority: row.seniority,
      experience: row.experience,
      technologies: row.technologies ?? [],
      locations: row.normalized_locations ?? [],
      remoteScope: row.remote_scope,
      industry: row.industry,
    },
  };
}

export interface MatchOutcome {
  response: MatchResponse;
  input: JobInput;
  evidence: EvidenceCheck;
  durationMs: number;
  modelCalls: number;
  outcome: "valid" | "valid_after_retry";
}

/**
 * Stores the answer even when the task was superseded meanwhile. Such a result
 * is history: it stays out of `current_matches` because the evaluation no longer
 * points at its key. A forced rematch replaces the row for the same key.
 */
export async function completeTask(pool: Pool, task: MatchTask, owner: string, config: MatchConfig, result: MatchOutcome): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    await client.query(`DELETE FROM match_results WHERE canonical_job_id = $1 AND input_key = $2`, [task.canonicalJobId, task.inputKey]);
    await client.query(
      `INSERT INTO match_results (canonical_job_id, task_id, input_key, content_hash, profile_revision_id, score, recommendation,
         response, model_name, model_digest, prompt_version, response_schema_version, rubric_version, inference_config,
         duration_ms, model_calls, input_truncated, input_estimated_tokens, input_original_chars, validation_outcome,
         evidence_total, evidence_literal, evidence_unverified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
      [
        task.canonicalJobId, task.id, task.inputKey, task.contentHash, task.profileRevisionId,
        result.response.score, result.response.recommendation, JSON.stringify(result.response),
        config.model, config.modelDigest, config.promptVersion, config.responseSchemaVersion, config.rubricVersion,
        JSON.stringify({ ...config.options, maxJobInputTokens: config.maxJobInputTokens }),
        result.durationMs, result.modelCalls, result.input.truncated, result.input.estimatedTokens, result.input.originalChars,
        result.outcome, result.evidence.total, result.evidence.literal, JSON.stringify(result.evidence.unverified),
      ],
    );
    const { rowCount } = await client.query(
      `UPDATE match_tasks SET status = 'succeeded', lease_owner = NULL, lease_until = NULL, last_error = NULL,
              last_error_kind = NULL, updated_at = now()
        WHERE id = $1 AND lease_owner = $2 AND status = 'claimed'`,
      [task.id, owner],
    );
    return (rowCount ?? 0) > 0;
  });
}

export interface RetryPolicy {
  maxAttempts: number;
  retryBaseSeconds: number;
}

const safeError = (message: string) => redact(message).slice(0, 500);

const backoffSeconds = `$3 * power(2, greatest(attempts - 1, 0))`;

/** Records a failed attempt. There is no fallback score: the job simply has no result yet. */
export async function failTask(pool: Pool, task: MatchTask, owner: string, policy: RetryPolicy, kind: string, message: string): Promise<string | null> {
  const { rows } = await retryTransient(() =>
    pool.query(
      `UPDATE match_tasks
          SET status = CASE WHEN attempts >= $4 THEN 'exhausted' ELSE 'pending' END,
              next_attempt_at = now() + make_interval(secs => ${backoffSeconds}),
              lease_owner = NULL, lease_until = NULL, last_error_kind = $5, last_error = $6, updated_at = now()
        WHERE id = $1 AND lease_owner = $2 AND status = 'claimed'
        RETURNING status`,
      [task.id, owner, policy.retryBaseSeconds, policy.maxAttempts, kind, safeError(message)],
    ),
  );
  return rows[0]?.status ?? null;
}

/** Gives the task back unharmed: an unreachable model says nothing about the job. */
export async function releaseTask(pool: Pool, task: MatchTask, owner: string, kind: string, message: string): Promise<void> {
  await retryTransient(() =>
    pool.query(
      `UPDATE match_tasks SET status = 'pending', attempts = attempts - 1, lease_owner = NULL, lease_until = NULL,
              last_error_kind = $3, last_error = $4, updated_at = now()
        WHERE id = $1 AND lease_owner = $2 AND status = 'claimed'`,
      [task.id, owner, kind, safeError(message)],
    ),
  );
}

/** Returns claims left by a crashed run. The lost attempt counts, so a crashing job cannot loop forever. */
export async function recoverAbandoned(pool: Pool, policy: RetryPolicy): Promise<number> {
  const { rowCount } = await retryTransient(() =>
    pool.query(
      `UPDATE match_tasks
          SET status = CASE WHEN attempts >= $1 THEN 'exhausted' ELSE 'pending' END,
              next_attempt_at = now() + make_interval(secs => ${backoffSeconds.replace("$3", "$2")}),
              lease_owner = NULL, lease_until = NULL, last_error_kind = 'abandoned',
              last_error = 'Claim expired before the worker finished', updated_at = now()
        WHERE status = 'claimed' AND lease_until < now()`,
      [policy.maxAttempts, policy.retryBaseSeconds],
    ),
  );
  return rowCount ?? 0;
}

/** Tasks a run could start now. Used to skip starting Ollama when there is nothing to do. */
export async function countRunnable(pool: Pool, config: MatchConfig): Promise<number> {
  const { rows } = await retryTransient(() =>
    pool.query(`SELECT count(*)::int AS n FROM match_tasks t WHERE ${RUNNABLE} AND t.next_attempt_at <= now()`, [hashMatchConfig(config)]),
  );
  return rows[0].n;
}

/** Time the AI stage has used since the UTC month began, which is how GitHub's allowance resets. */
export async function readAiMinutesThisMonth(pool: Pool): Promise<number> {
  const { rows } = await retryTransient(() =>
    pool.query(
      `SELECT coalesce(sum(extract(epoch FROM finished_at - started_at)), 0) / 60 AS minutes
         FROM match_runs WHERE started_at >= date_trunc('month', now(), 'UTC')`,
    ),
  );
  return Math.round(Number(rows[0].minutes));
}

export interface AffordableWork {
  pending: number;
  runnable: number;
  minutesUsed: number;
}

/**
 * A long backlog must not spend the Actions allowance, because GitHub would then
 * block discovery too. Past the monthly cap Ollama stays off and tasks stay queued.
 */
export async function countAffordable(pool: Pool, config: MatchConfig, minutesPerMonth: number): Promise<AffordableWork> {
  const [runnable, minutesUsed] = await Promise.all([countRunnable(pool, config), readAiMinutesThisMonth(pool)]);
  return { pending: minutesUsed >= minutesPerMonth ? 0 : runnable, runnable, minutesUsed };
}

export interface Backlog {
  pending: number;
  due: number;
  oldestAgeSeconds: number | null;
  exhausted: number;
}

export const readBacklog = (pool: Pool, config: MatchConfig) => readBacklogFor(pool, hashMatchConfig(config));

/** The dashboard knows the worker's configuration only as the hash it stored. */
export async function readBacklogFor(pool: Pool, configHash: string): Promise<Backlog> {
  const { rows } = await retryTransient(() =>
    pool.query(
      `SELECT count(*) FILTER (WHERE ${RUNNABLE})::int AS pending,
              count(*) FILTER (WHERE ${RUNNABLE} AND t.next_attempt_at <= now())::int AS due,
              extract(epoch FROM now() - min(t.created_at) FILTER (WHERE ${RUNNABLE}))::int AS oldest,
              count(*) FILTER (WHERE t.status = 'exhausted' AND EXISTS (
                SELECT 1 FROM job_evaluations e WHERE e.canonical_job_id = t.canonical_job_id AND e.input_key = t.input_key
              ))::int AS exhausted
         FROM match_tasks t`,
      [configHash],
    ),
  );
  const row = rows[0];
  return { pending: row.pending, due: row.due, oldestAgeSeconds: row.oldest, exhausted: row.exhausted };
}

const CURRENT_TASK = `EXISTS (SELECT 1 FROM job_evaluations e
                               WHERE e.canonical_job_id = t.canonical_job_id AND e.input_key = t.input_key)`;

const REOPEN = `status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL, last_error_kind = NULL, updated_at = now()`;

/** Operator action: gives exhausted or backing-off work a fresh set of attempts. */
export async function retryFailedTasks(pool: Pool): Promise<number> {
  const { rowCount } = await retryTransient(() =>
    pool.query(
      `UPDATE match_tasks t SET ${REOPEN}
        WHERE ${CURRENT_TASK} AND (t.status = 'exhausted' OR (t.status = 'pending' AND t.attempts > 0))`,
    ),
  );
  return rowCount ?? 0;
}

/** Operator action: re-asks the model about every current job. Still bounded per run by the normal limits. */
export async function forceRematch(pool: Pool): Promise<number> {
  const { rowCount } = await retryTransient(() =>
    pool.query(`UPDATE match_tasks t SET ${REOPEN} WHERE ${CURRENT_TASK} AND t.status IN ('succeeded', 'exhausted')`),
  );
  return rowCount ?? 0;
}
