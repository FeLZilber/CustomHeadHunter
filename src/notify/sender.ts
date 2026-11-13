import { randomUUID } from "node:crypto";
import { retryTransient, withTransaction, type Pool, type Queryable } from "../db/pool";
import type { Logger } from "../logger";
import { renderAlert, renderDigest, type AlertEvent, type JobCard } from "./message";
import {
  claimNotification,
  deferNotification,
  explainMissingVerdict,
  failNotification,
  jobEventType,
  listDue,
  loadCurrentJobs,
  markAmbiguous,
  markSending,
  markSent,
  planNotifications,
  planRematchDigest,
  recoverNotificationClaims,
  reopenNotifications,
  retryNotification,
  suppressNotification,
  type CurrentJob,
  type Notification,
  type NotificationKind,
  type PlanSummary,
  type Relevance,
} from "./outbox";
import type { MessageSender } from "./telegram";

/** Telegram's FAQ: avoid more than one message per second to a single chat. */
const SEND_SPACING_MS = 1_000;
const CLAIM_LEASE_SECONDS = 120;
const DEFER_SECONDS = 3_600;
const MAX_FLOOD_WAIT_SECONDS = 60;

export interface NotifyOptions {
  trigger: string;
  relevance: Relevance;
  dryRun: boolean;
  maxAlerts: number;
  maxDigests: number;
  digestSize: number;
  maxAttempts: number;
  retryBaseSeconds: number;
  timeBudgetSeconds: number;
  rematchDigest?: boolean;
  reopen?: Array<"ambiguous" | "failed">;
}

export interface NotifyDeps {
  pool: Pool;
  /** Null when no credentials are configured. Planning still happens, so nothing is lost. */
  sender: MessageSender | null;
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
}

export type NotifyStatus = "succeeded" | "partial" | "failed" | "not_configured" | "dry_run";

export interface NotifySummary extends PlanSummary {
  runId: string;
  status: NotifyStatus;
  reopened: number;
  recovered: number;
  sent: number;
  suppressed: number;
  deferred: number;
  retrying: number;
  ambiguous: number;
  failed: number;
  stopReason: string | null;
}

type Prepared =
  | { action: "send"; html: string; inputKey: string | null; jobIds: string[] }
  | { action: "suppress"; reason: string }
  | { action: "defer" };

function toCard(job: CurrentJob): JobCard {
  const unverified = new Set(job.evidenceUnverified);
  const missing: Array<{ requirement: string; evidence: string }> = job.response.missing_requirements ?? [];
  const confirmed = missing.filter((gap) => !unverified.has(gap.evidence));
  return {
    title: job.title,
    company: job.company,
    location: job.location,
    score: job.score,
    technologies: [...job.technologies]
      .sort((a, b) => Number(b.level === "required") - Number(a.level === "required"))
      .map((technology) => technology.name),
    gaps: confirmed.map((gap) => gap.requirement),
    unconfirmedGaps: missing.length - confirmed.length,
    explanation: job.response.explanation,
    discoveredAt: job.discoveredAt,
    url: job.applicationUrl,
  };
}

/** A queued event may be hours old, so it is judged against the database as it is now. */
async function prepareAlert(db: Queryable, item: Notification, relevance: Relevance): Promise<Prepared> {
  const [job] = await loadCurrentJobs(db, [item.canonicalJobId!], relevance);
  if (!job) {
    const state = await explainMissingVerdict(db, item.canonicalJobId!, relevance);
    if (state === "pending") return { action: "defer" };
    return { action: "suppress", reason: state === "inactive" ? "job_inactive" : "no_current_match" };
  }
  if (job.score < relevance.threshold) return { action: "suppress", reason: "below_threshold" };
  const event = (await jobEventType(db, item.jobEventId!)) as AlertEvent;
  return { action: "send", html: renderAlert(event, toCard(job)), inputKey: job.inputKey, jobIds: [] };
}

async function prepareDigest(db: Queryable, item: Notification, relevance: Relevance): Promise<Prepared> {
  const jobs = (await loadCurrentJobs(db, item.jobIds, relevance)).filter((job) => job.score >= relevance.threshold);
  if (jobs.length === 0) return { action: "suppress", reason: "no_qualifying_jobs" };
  const heading = item.eventKey.startsWith("baseline:")
    ? `Top current matches at ${jobs[0]!.company}`
    : "Older jobs that now match";
  // Jobs arrive best first, so each role is shown by its best posting and links the others.
  const roles = new Map<string, CurrentJob[]>();
  for (const job of jobs) roles.set(job.siblingKey, [...(roles.get(job.siblingKey) ?? []), job]);
  const cards = [...roles.values()].map(([best, ...others]) => ({
    ...toCard(best!),
    otherPostings: others.map((job) => ({ location: job.location, url: job.applicationUrl })),
  }));
  return {
    action: "send",
    html: renderDigest(heading, cards, item.moreCount),
    inputKey: null,
    jobIds: jobs.map((job) => job.id),
  };
}

const prepare = (db: Queryable, item: Notification, relevance: Relevance) =>
  item.kind === "alert" ? prepareAlert(db, item, relevance) : prepareDigest(db, item, relevance);

class DryRunFinished extends Error {}

/** Plans inside a transaction that is always rolled back, so a dry run shows real decisions and leaves no rows. */
async function previewRun(deps: NotifyDeps, options: NotifyOptions, summary: NotifySummary) {
  const { relevance } = options;
  try {
    await withTransaction(deps.pool, async (client) => {
      Object.assign(summary, await planNotifications(client, relevance, options.digestSize));
      if (options.rematchDigest) summary.digests += await planRematchDigest(client, relevance, options.digestSize);
      const limits: Array<[NotificationKind, number]> = [["digest", options.maxDigests], ["alert", options.maxAlerts]];
      for (const [kind, limit] of limits) {
        for (const item of await listDue(client, relevance.profileId, kind, limit)) {
          const prepared = await prepare(client, item, relevance);
          if (prepared.action === "send") {
            summary.sent += 1;
            deps.log.info("Dry run would send", { kind, eventKey: item.eventKey, chars: prepared.html.length });
          } else if (prepared.action === "suppress") {
            summary.suppressed += 1;
            deps.log.info("Dry run would suppress", { kind, eventKey: item.eventKey, reason: prepared.reason });
          } else {
            summary.deferred += 1;
          }
        }
      }
      throw new DryRunFinished();
    });
  } catch (error) {
    if (!(error instanceof DryRunFinished)) throw error;
  }
}

interface Delivery {
  pool: Pool;
  sender: MessageSender;
  log: Logger;
  sleep: (ms: number) => Promise<void>;
  owner: string;
  options: NotifyOptions;
  summary: NotifySummary;
  deadline: number;
  lastSendAt: number;
}

/** Sends one claimed message. Returns why the run must stop, or null to carry on. */
async function deliver(context: Delivery, item: Notification, html: string, inputKey: string | null, jobIds: string[]): Promise<string | null> {
  const { pool, sender, sleep, owner, options, summary } = context;
  if (!(await markSending(pool, item.id, owner))) return null;

  const wait = context.lastSendAt + SEND_SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  const outcome = await sender.send(html);
  context.lastSendAt = Date.now();

  switch (outcome.kind) {
    case "sent":
      await markSent(pool, item.id, outcome.messageId, inputKey, jobIds);
      summary.sent += 1;
      return null;
    case "rate_limited":
      await retryNotification(pool, item.id, owner, outcome.retryAfterSeconds, "rate_limited", outcome.detail, false);
      summary.retrying += 1;
      if (outcome.retryAfterSeconds > MAX_FLOOD_WAIT_SECONDS) return "rate_limited";
      await sleep(outcome.retryAfterSeconds * 1000);
      return null;
    case "not_delivered": {
      if (item.attempts + 1 >= options.maxAttempts) {
        await failNotification(pool, item.id, owner, "not_delivered", outcome.detail);
        summary.failed += 1;
      } else {
        const delay = options.retryBaseSeconds * 2 ** item.attempts;
        await retryNotification(pool, item.id, owner, delay, "not_delivered", outcome.detail, true);
        summary.retrying += 1;
      }
      return "telegram_unavailable";
    }
    case "rejected":
      await failNotification(pool, item.id, owner, "rejected", outcome.detail);
      summary.failed += 1;
      return null;
    case "misconfigured":
      await retryNotification(pool, item.id, owner, 0, "misconfigured", outcome.detail, false);
      summary.retrying += 1;
      return "misconfigured";
    case "ambiguous":
      await markAmbiguous(pool, item.id, owner, outcome.detail);
      summary.ambiguous += 1;
      return "delivery_unconfirmed";
  }
}

async function deliverKind(context: Delivery, kind: NotificationKind, limit: number): Promise<string | null> {
  const { pool, owner, options, summary } = context;
  let delivered = 0;
  while (delivered < limit) {
    if (Date.now() >= context.deadline) return "time_budget";
    const item = await claimNotification(pool, options.relevance.profileId, kind, owner, CLAIM_LEASE_SECONDS);
    if (!item) return null;
    const prepared = await retryTransient(() => prepare(pool, item, options.relevance));
    if (prepared.action === "suppress") {
      await suppressNotification(pool, item.id, owner, prepared.reason);
      summary.suppressed += 1;
      continue;
    }
    if (prepared.action === "defer") {
      await deferNotification(pool, item.id, owner, DEFER_SECONDS);
      summary.deferred += 1;
      continue;
    }
    const stop = await deliver(context, item, prepared.html, prepared.inputKey, prepared.jobIds);
    if (stop) return stop;
    delivered += 1;
  }
  return null;
}

function resolveStatus(sender: MessageSender | null, options: NotifyOptions, summary: NotifySummary): NotifyStatus {
  if (options.dryRun) return "dry_run";
  if (!sender) return "not_configured";
  if (summary.stopReason === "misconfigured") return "failed";
  if (summary.retrying || summary.ambiguous || summary.failed) return "partial";
  return "succeeded";
}

/** Recheck, send, record. The database never holds a transaction open across a request to Telegram. */
export async function runNotify(deps: NotifyDeps, options: NotifyOptions): Promise<NotifySummary> {
  const { pool, sender, log } = deps;
  const { rows } = await retryTransient(() =>
    pool.query(`INSERT INTO notify_runs (trigger) VALUES ($1) RETURNING id`, [options.trigger]),
  );
  const summary: NotifySummary = {
    runId: rows[0].id,
    status: "succeeded",
    alerts: 0,
    digests: 0,
    reopened: 0,
    recovered: 0,
    sent: 0,
    suppressed: 0,
    deferred: 0,
    retrying: 0,
    ambiguous: 0,
    failed: 0,
    stopReason: null,
  };

  try {
    if (options.dryRun) {
      await previewRun(deps, options, summary);
    } else {
      const recovered = await recoverNotificationClaims(pool);
      summary.recovered = recovered.released + recovered.ambiguous;
      summary.ambiguous += recovered.ambiguous;
      if (options.reopen?.length) summary.reopened = await reopenNotifications(pool, options.reopen);
      Object.assign(
        summary,
        await withTransaction(pool, (client) => planNotifications(client, options.relevance, options.digestSize)),
      );
      if (options.rematchDigest) {
        summary.digests += await withTransaction(pool, (client) =>
          planRematchDigest(client, options.relevance, options.digestSize),
        );
      }
      if (sender) {
        const context: Delivery = {
          pool,
          sender,
          log,
          sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
          owner: `notify-${randomUUID()}`,
          options,
          summary,
          deadline: Date.now() + options.timeBudgetSeconds * 1000,
          lastSendAt: 0,
        };
        summary.stopReason =
          (await deliverKind(context, "digest", options.maxDigests)) ?? (await deliverKind(context, "alert", options.maxAlerts));
      } else {
        log.warn("Telegram is not configured; events stay pending", { alerts: summary.alerts, digests: summary.digests });
      }
    }
    summary.status = resolveStatus(sender, options, summary);
  } catch (error) {
    summary.status = "failed";
    await retryTransient(() =>
      pool.query(`UPDATE notify_runs SET status = 'failed', finished_at = now(), summary = $2 WHERE id = $1`, [
        summary.runId,
        JSON.stringify(summary),
      ]),
    ).catch(() => {});
    throw error;
  }

  await retryTransient(() =>
    pool.query(`UPDATE notify_runs SET status = $2, finished_at = now(), summary = $3 WHERE id = $1`, [
      summary.runId,
      summary.status,
      JSON.stringify(summary),
    ]),
  );
  return summary;
}
