import { z } from "zod";
import { retryTransient, type Pool, type Queryable } from "../db/pool";
import { FILTER_VERSION } from "../filter";
import type { Profile } from "../profile/schema";
import { ensureProfile } from "../profile/store";
import { readHealth, type Health } from "../worker/maintenance";
import type { MatchDetail } from "./types";

export const PAGE_SIZE = 30;

const blankToUndefined = (value: unknown) => (value === "" ? undefined : value);
const term = z.preprocess(blankToUndefined, z.string().trim().max(100).optional()).catch(undefined);

/** Query strings are untrusted and bookmarkable, so a bad value falls back instead of failing the page. */
export const JobFiltersSchema = z.object({
  q: term,
  company: term,
  location: term,
  technology: term,
  status: z.enum(["active", "expired", "all"]).catch("active"),
  match: z.enum(["all", "current", "pending", "stale", "filtered", "failed"]).catch("all"),
  minScore: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).max(100).optional()).catch(undefined),
  posted: z.enum(["any", "14", "30", "90"]).catch("any"),
  sort: z.enum(["best", "latest", "posted"]).catch("best"),
  page: z.coerce.number().int().min(1).max(10_000).catch(1),
});

export type JobFilters = z.infer<typeof JobFiltersSchema>;

export function parseFilters(params: Record<string, string | string[] | undefined>): JobFilters {
  const first = Object.fromEntries(Object.entries(params).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
  return JobFiltersSchema.parse(first);
}

export interface ViewContext {
  profile: Profile;
  configHash: string;
}

/**
 * The worker's budget settings feed the config hash and are not the dashboard's
 * to know, so the newest evaluation stands for its configuration. `evaluate`
 * rewrites every row when the configuration changes.
 */
export async function loadContext(pool: Pool): Promise<ViewContext> {
  const profile = await ensureProfile(pool);
  const { rows } = await retryTransient(() =>
    pool.query(`SELECT config_hash FROM job_evaluations ORDER BY evaluated_at DESC, canonical_job_id DESC LIMIT 1`),
  );
  return { profile, configHash: rows[0]?.config_hash ?? "" };
}

/** Why the owner marked a job "not relevant". The database enforces the same list. */
export const DISMISS_REASONS = ["wrong_role", "wrong_seniority", "wrong_location", "wrong_company", "other"] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

/** What the page may claim about a job's score. */
export type MatchState = "not_evaluated" | "stale" | "filtered" | "current" | "failed" | "pending";

const JOB_ROWS = `
  canonical_jobs c
  JOIN companies co ON co.id = c.company_id
  JOIN LATERAL (SELECT * FROM source_listings sl WHERE sl.canonical_job_id = c.id
                 ORDER BY (sl.status = 'active') DESC, sl.last_seen_at DESC, sl.id LIMIT 1) l ON true
  LEFT JOIN job_evaluations e ON e.canonical_job_id = c.id
  LEFT JOIN LATERAL (SELECT * FROM match_results mr WHERE mr.canonical_job_id = c.id
                      ORDER BY (mr.input_key = e.input_key) DESC NULLS LAST, mr.id DESC LIMIT 1) r ON true
  LEFT JOIN match_tasks t ON t.canonical_job_id = c.id AND t.input_key = e.input_key
  LEFT JOIN saved_jobs s ON s.canonical_job_id = c.id AND s.profile_id = $1
  LEFT JOIN job_applications ja ON ja.canonical_job_id = c.id AND ja.profile_id = $1
  LEFT JOIN dismissed_jobs dj ON dj.canonical_job_id = c.id AND dj.profile_id = $1`;

const MATCH_STATE = `
  CASE
    WHEN e.canonical_job_id IS NULL THEN 'not_evaluated'
    WHEN e.profile_hash <> $2 OR e.config_hash <> $3 OR e.filter_version <> $4 OR e.content_hash <> l.content_hash THEN 'stale'
    WHEN e.decision = 'rejected' THEN 'filtered'
    WHEN r.input_key = e.input_key THEN 'current'
    WHEN t.status = 'exhausted' THEN 'failed'
    ELSE 'pending'
  END`;

const JOB_COLUMNS = `
  c.id, c.title, co.name AS company, c.status, c.first_discovered_at, c.last_seen_at,
  l.original_location, l.work_arrangement, l.technologies, l.application_url, l.published_at,
  COALESCE(l.published_at, c.first_discovered_at) AS posted_or_found_at,
  r.score, r.recommendation, s.saved_at, ja.applied_at, dj.reason AS dismissed_reason, e.reason_codes, ${MATCH_STATE} AS match_state`;

const contextParams = ({ profile, configHash }: ViewContext) => [profile.profileId, profile.matchingHash, configHash, FILTER_VERSION];

export interface JobSummary {
  id: string;
  title: string;
  company: string;
  status: "active" | "expired";
  location: string | null;
  workArrangement: string | null;
  technologies: string[];
  applicationUrl: string;
  /** Null when the provider gives no publishing date. */
  postedAt: Date | null;
  discoveredAt: Date;
  lastSeenAt: Date;
  matchState: MatchState;
  /** Present for current and stale results only. A filtered job's old score says nothing. */
  score: number | null;
  recommendation: string | null;
  reasonCodes: string[];
  saved: boolean;
  /** When the owner marked the job as applied for. Independent of the posting's lifecycle. */
  appliedAt: Date | null;
  /** Set when the owner marked the job "not relevant". Dismissed jobs leave the main lists. */
  dismissedReason: DismissReason | null;
}

function toSummary(row: Record<string, any>): JobSummary {
  const scored = row.match_state === "current" || row.match_state === "stale" || row.match_state === "pending";
  return {
    id: row.id,
    title: row.title,
    company: row.company,
    status: row.status,
    location: row.original_location,
    workArrangement: row.work_arrangement,
    technologies: (row.technologies as Array<{ name: string }>).map((technology) => technology.name),
    applicationUrl: row.application_url,
    postedAt: row.published_at,
    discoveredAt: row.first_discovered_at,
    lastSeenAt: row.last_seen_at,
    matchState: row.match_state,
    score: scored ? row.score : null,
    recommendation: scored ? row.recommendation : null,
    reasonCodes: row.reason_codes ?? [],
    saved: row.saved_at !== null,
    appliedAt: row.applied_at,
    dismissedReason: row.dismissed_reason ?? null,
  };
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");

export interface JobPage {
  jobs: JobSummary[];
  hasMore: boolean;
}

export async function searchJobs(db: Queryable, context: ViewContext, filters: JobFilters, only?: "saved" | "applied" | "dismissed"): Promise<JobPage> {
  const params: unknown[] = contextParams(context);
  const bind = (value: unknown) => `$${params.push(value)}`;
  const contains = (value: string) => bind(`%${escapeLike(value)}%`);
  const where: string[] = [];
  if (filters.status !== "all") where.push(`status = ${bind(filters.status)}`);
  if (filters.match !== "all") where.push(`match_state = ${bind(filters.match)}`);
  if (filters.q) where.push(`title ILIKE ${contains(filters.q)}`);
  if (filters.company) where.push(`company ILIKE ${contains(filters.company)}`);
  if (filters.location) where.push(`original_location ILIKE ${contains(filters.location)}`);
  if (filters.technology) {
    where.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(technologies) tech WHERE tech->>'name' ILIKE ${contains(filters.technology)})`);
  }
  if (filters.minScore !== undefined) where.push(`match_state = 'current' AND score >= ${bind(filters.minScore)}`);
  if (filters.posted !== "any") where.push(`posted_or_found_at >= now() - make_interval(days => ${bind(Number(filters.posted))})`);
  if (only === "saved") where.push(`saved_at IS NOT NULL`);
  if (only === "applied") where.push(`applied_at IS NOT NULL`);
  // Saved and applied views keep showing a job even if it was dismissed; the main lists do not.
  if (only === "dismissed") where.push(`dismissed_reason IS NOT NULL`);
  if (only === undefined) where.push(`dismissed_reason IS NULL`);

  const orders = {
    best: `CASE WHEN match_state = 'current' THEN score END DESC NULLS LAST, first_discovered_at DESC, id DESC`,
    latest: `first_discovered_at DESC, id DESC`,
    posted: `posted_or_found_at DESC, id DESC`,
  };
  const order = orders[filters.sort];
  const { rows } = await db.query(
    `SELECT * FROM (SELECT ${JOB_COLUMNS} FROM ${JOB_ROWS}) job
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${order}
      LIMIT ${PAGE_SIZE + 1} OFFSET ${(filters.page - 1) * PAGE_SIZE}`,
    params,
  );
  return { jobs: rows.slice(0, PAGE_SIZE).map(toSummary), hasMore: rows.length > PAGE_SIZE };
}

export interface JobDetail extends JobSummary {
  description: string;
  match: MatchDetail | null;
  events: Array<{ type: string; at: Date }>;
}

export async function getJob(db: Queryable, context: ViewContext, id: string): Promise<JobDetail | null> {
  const { rows } = await db.query(
    `SELECT ${JOB_COLUMNS}, l.description_text, r.response, r.evidence_unverified, r.input_truncated,
            r.evidence_total, r.evidence_literal, r.model_name, r.prompt_version, r.created_at AS matched_at
       FROM ${JOB_ROWS}
      WHERE c.id = $5`,
    [...contextParams(context), id],
  );
  const row = rows[0];
  if (!row) return null;
  const summary = toSummary(row);
  const { rows: events } = await db.query(
    `SELECT event_type, created_at FROM job_events WHERE canonical_job_id = $1 ORDER BY id DESC LIMIT 20`,
    [id],
  );
  return {
    ...summary,
    description: row.description_text,
    match:
      summary.score === null
        ? null
        : {
            response: row.response,
            unverified: row.evidence_unverified,
            inputTruncated: row.input_truncated,
            evidenceTotal: row.evidence_total,
            evidenceLiteral: row.evidence_literal,
            model: row.model_name,
            promptVersion: row.prompt_version,
            matchedAt: row.matched_at,
          },
    events: events.map((event) => ({ type: event.event_type, at: event.created_at })),
  };
}

/** Idempotent in both directions, so a double submit or a stale tab does no harm. */
export async function setSaved(db: Queryable, profileId: string, jobId: string, saved: boolean): Promise<void> {
  if (saved) {
    await db.query(
      `INSERT INTO saved_jobs (profile_id, canonical_job_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [profileId, jobId],
    );
  } else {
    await db.query(`DELETE FROM saved_jobs WHERE profile_id = $1 AND canonical_job_id = $2`, [profileId, jobId]);
  }
}

/** Idempotent. Marking again keeps the first date, so a double submit does not move it. */
export async function setApplied(db: Queryable, profileId: string, jobId: string, applied: boolean): Promise<void> {
  if (applied) {
    await db.query(
      `INSERT INTO job_applications (profile_id, canonical_job_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [profileId, jobId],
    );
  } else {
    await db.query(`DELETE FROM job_applications WHERE profile_id = $1 AND canonical_job_id = $2`, [profileId, jobId]);
  }
}

/** Idempotent. Dismissing again changes the reason and keeps the first date; `null` restores the job. */
export async function setDismissed(db: Queryable, profileId: string, jobId: string, reason: DismissReason | null): Promise<void> {
  if (reason) {
    await db.query(
      `INSERT INTO dismissed_jobs (profile_id, canonical_job_id, reason) VALUES ($1, $2, $3)
       ON CONFLICT (profile_id, canonical_job_id) DO UPDATE SET reason = EXCLUDED.reason`,
      [profileId, jobId, reason],
    );
  } else {
    await db.query(`DELETE FROM dismissed_jobs WHERE profile_id = $1 AND canonical_job_id = $2`, [profileId, jobId]);
  }
}

export interface DismissalSummary {
  total: number;
  byReason: Array<{ reason: DismissReason; count: number }>;
  /** Companies dismissed at least twice, the likeliest candidates for an exclusion. */
  repeatCompanies: Array<{ company: string; count: number }>;
}

export async function readDismissals(db: Queryable, profileId: string): Promise<DismissalSummary> {
  const { rows: reasons } = await db.query(
    `SELECT reason, count(*)::int AS count FROM dismissed_jobs WHERE profile_id = $1 GROUP BY reason ORDER BY count DESC, reason`,
    [profileId],
  );
  const { rows: companies } = await db.query(
    `SELECT co.name AS company, count(*)::int AS count
       FROM dismissed_jobs dj
       JOIN canonical_jobs c ON c.id = dj.canonical_job_id
       JOIN companies co ON co.id = c.company_id
      WHERE dj.profile_id = $1
      GROUP BY co.name HAVING count(*) >= 2
      ORDER BY count DESC, co.name LIMIT 5`,
    [profileId],
  );
  return {
    total: reasons.reduce((sum, row) => sum + row.count, 0),
    byReason: reasons.map((row) => ({ reason: row.reason, count: row.count })),
    repeatCompanies: companies.map((row) => ({ company: row.company, count: row.count })),
  };
}

export interface SourceProblem {
  company: string;
  provider: string;
  outcome: string;
  error: string | null;
  at: Date | null;
}

export interface DeliveryProblem {
  id: string;
  status: "ambiguous" | "failed";
  kind: string;
  title: string | null;
  error: string | null;
  updatedAt: Date;
}

export interface LatestMatchRun {
  status: string;
  finishedAt: Date | null;
  stopReason: string | null;
  succeeded: number;
  failed: number;
}

export interface OperationsStatus {
  health: Health;
  sourceProblems: SourceProblem[];
  deliveryProblems: DeliveryProblem[];
  latestMatch: LatestMatchRun | null;
}

export async function readStatus(pool: Pool, context: ViewContext, staleHours: number): Promise<OperationsStatus> {
  const [health, sources, deliveries, matches] = await Promise.all([
    readHealth(pool, context.configHash, staleHours),
    pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (s.source_id) co.name AS company, js.provider, s.outcome, s.error, s.finished_at
           FROM source_snapshots s
           JOIN job_sources js ON js.id = s.source_id AND js.enabled
           JOIN companies co ON co.id = js.company_id
          WHERE s.outcome <> 'running'
          ORDER BY s.source_id, s.started_at DESC
       ) latest
       WHERE outcome NOT IN ('complete', 'not_modified')
       ORDER BY company`,
    ),
    pool.query(
      `SELECT n.id, n.status, n.kind, n.last_error, n.updated_at, c.title
         FROM notifications n LEFT JOIN canonical_jobs c ON c.id = n.canonical_job_id
        WHERE n.status IN ('ambiguous', 'failed')
        ORDER BY n.updated_at DESC LIMIT 50`,
    ),
    pool.query(`SELECT status, finished_at, summary FROM match_runs ORDER BY id DESC LIMIT 1`),
  ]);
  const match = matches.rows[0];
  return {
    health,
    sourceProblems: sources.rows.map((row) => ({
      company: row.company,
      provider: row.provider,
      outcome: row.outcome,
      error: row.error,
      at: row.finished_at,
    })),
    deliveryProblems: deliveries.rows.map((row) => ({
      id: row.id,
      status: row.status,
      kind: row.kind,
      title: row.title,
      error: row.last_error,
      updatedAt: row.updated_at,
    })),
    latestMatch: match
      ? {
          status: match.status,
          finishedAt: match.finished_at,
          stopReason: match.summary.stopReason ?? null,
          succeeded: match.summary.succeeded ?? 0,
          failed: match.summary.failed ?? 0,
        }
      : null,
  };
}
