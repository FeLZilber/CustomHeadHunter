import { randomUUID } from "node:crypto";
import { retryTransient, type Pool } from "../db/pool";
import type { Logger } from "../logger";
import { hashMatchConfig, type MatchConfig } from "./config";
import { OllamaError, type ChatMessage, type OllamaClient } from "./ollama-client";
import { buildMatchMessages, prepareJobDescription, verifyEvidence } from "./prompt";
import {
  claimTask,
  completeTask,
  countRunnable,
  failTask,
  readBacklog,
  recoverAbandoned,
  releaseTask,
  type Backlog,
  type MatchOutcome,
  type MatchTask,
  type RetryPolicy,
} from "./queue";
import { scoreFacts } from "./facts";
import { deriveMatchResponse, modelOutputJsonSchema, ModelOutputSchema, type ModelOutput } from "./schema";

export type MatchModel = Pick<OllamaClient, "modelDigest" | "chat">;

export interface MatchOptions extends RetryPolicy {
  trigger: string;
  config: MatchConfig;
  maxJobs: number;
  timeBudgetSeconds: number;
  inferenceTimeoutSeconds: number;
}

export interface MatchDeps {
  pool: Pool;
  model: MatchModel;
  log: Logger;
  now?: () => number;
  /** Scores the posting's structured facts. Replaceable so tests can pin the score. */
  scoreFacts?: typeof scoreFacts;
}

export type StopReason =
  | "queue_empty"
  | "job_cap"
  | "time_budget"
  | "model_unavailable"
  | "model_error"
  | "digest_mismatch"
  | "error";

export interface MatchSummary {
  runId: string;
  status: "succeeded" | "failed";
  stopReason: StopReason;
  error: string | null;
  durationMs: number;
  claimed: number;
  succeeded: number;
  failed: number;
  exhausted: number;
  recovered: number;
  validationRetries: number;
  truncatedInputs: number;
  superseded: number;
  backlog: Backlog;
}

export type ParsedOutput =
  | { ok: true; output: ModelOutput }
  | { ok: false; kind: "truncated" | "invalid_json" | "invalid_schema"; feedback: string };

/** The only repair allowed: removing wrapping around the JSON, never changing its content. */
export function stripJsonWrapping(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

export function parseModelOutput(content: string, doneReason: string | null): ParsedOutput {
  let value: unknown;
  try {
    value = JSON.parse(stripJsonWrapping(content));
  } catch {
    return doneReason === "length"
      ? { ok: false, kind: "truncated", feedback: "Your reply was cut off because it was too long. Reply again with fewer items and shorter text." }
      : { ok: false, kind: "invalid_json", feedback: "Your reply was not valid JSON. Reply again with only the JSON form." };
  }
  const parsed = ModelOutputSchema.safeParse(value);
  if (parsed.success) return { ok: true, output: parsed.data };
  const issues = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`);
  return { ok: false, kind: "invalid_schema", feedback: `Your reply failed validation. Fix these fields: ${issues.join("; ")}` };
}

class InferenceFailure extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

async function askModel(deps: MatchDeps, config: MatchConfig, messages: ChatMessage[], timeoutMs: number) {
  const chat = await deps.model.chat({
    model: config.model,
    messages,
    format: modelOutputJsonSchema,
    options: config.options,
    timeoutMs,
    keepAlive: "30m",
  });
  return parseModelOutput(chat.content, chat.doneReason);
}

/** Asks once, and at most once more with the validation feedback if time remains for it. */
async function inferMatch(deps: MatchDeps, options: MatchOptions, task: MatchTask, deadline: number): Promise<MatchOutcome & { retried: boolean }> {
  const now = deps.now ?? Date.now;
  const started = now();
  const timeoutMs = options.inferenceTimeoutSeconds * 1000;
  const input = prepareJobDescription(task.job.description, options.config.maxJobInputTokens);
  const messages = buildMatchMessages(task.matching, task.job, input);

  let reply = await askModel(deps, options.config, messages, timeoutMs);
  let modelCalls = 1;
  if (!reply.ok && now() + timeoutMs <= deadline) {
    const feedback: ChatMessage = { role: "user", content: reply.feedback };
    reply = await askModel(deps, options.config, [...messages, feedback], timeoutMs);
    modelCalls = 2;
  }
  if (!reply.ok) throw new InferenceFailure(reply.kind, reply.feedback);

  const source = [task.job.title, task.job.company, task.job.location ?? "", input.text].join("\n");
  return {
    response: deriveMatchResponse(reply.output, (deps.scoreFacts ?? scoreFacts)(task.matching, task.facts)),
    input,
    evidence: verifyEvidence(reply.output, source),
    durationMs: now() - started,
    modelCalls,
    outcome: modelCalls === 1 ? "valid" : "valid_after_retry",
    retried: modelCalls === 2,
  };
}

type Verified = { ok: true } | { ok: false; reason: StopReason; message: string };

async function verifyModel(model: MatchModel, config: MatchConfig): Promise<Verified> {
  let digest: string | null;
  try {
    digest = await model.modelDigest(config.model);
  } catch (error) {
    return { ok: false, reason: "model_unavailable", message: String(error) };
  }
  // A different digest would store answers under a key that claims the locked model.
  return digest === config.modelDigest
    ? { ok: true }
    : { ok: false, reason: "digest_mismatch", message: `${config.model} resolved to ${digest ?? "nothing"}, expected ${config.modelDigest}` };
}

/** One task. Returns a reason to stop the stage, or null to carry on. */
async function runTask(deps: MatchDeps, options: MatchOptions, task: MatchTask, owner: string, deadline: number, summary: MatchSummary): Promise<StopReason | null> {
  const { pool, log } = deps;
  try {
    const result = await inferMatch(deps, options, task, deadline);
    const kept = await completeTask(pool, task, owner, options.config, result);
    if (kept) summary.succeeded += 1;
    else summary.superseded += 1;
    if (result.retried) summary.validationRetries += 1;
    if (result.input.truncated) summary.truncatedInputs += 1;
    log.info("Job matched", {
      task: task.id,
      score: result.response.score,
      recommendation: result.response.recommendation,
      durationMs: result.durationMs,
      modelCalls: result.modelCalls,
      truncated: result.input.truncated,
      evidence: `${result.evidence.literal}/${result.evidence.total}`,
    });
    return null;
  } catch (error) {
    if (error instanceof OllamaError && error.kind === "unavailable") {
      await releaseTask(pool, task, owner, error.kind, error.message);
      summary.error = error.message;
      return "model_unavailable";
    }
    if (!(error instanceof OllamaError) && !(error instanceof InferenceFailure)) throw error;
    const status = await failTask(pool, task, owner, options, error.kind, error.message);
    summary.failed += 1;
    if (status === "exhausted") summary.exhausted += 1;
    log.warn("Match attempt failed", { task: task.id, kind: error.kind, attempt: task.attempts, status });
    // A server error may come from this job or from Ollama itself. Counting the
    // attempt stops one bad job blocking the queue for ever; stopping protects the rest.
    if (error instanceof OllamaError && error.kind === "http") {
      summary.error = error.message;
      return "model_error";
    }
    return null;
  }
}

async function drainQueue(deps: MatchDeps, options: MatchOptions, runId: string, deadline: number, summary: MatchSummary): Promise<StopReason> {
  const now = deps.now ?? Date.now;
  const owner = `${runId}:${randomUUID()}`;
  // Two full calls plus the writes around them.
  const leaseSeconds = options.inferenceTimeoutSeconds * 2 + 60;
  for (;;) {
    if (summary.claimed >= options.maxJobs) return "job_cap";
    // Never start what the budget cannot finish: the workflow timeout would lose the work.
    if (now() + options.inferenceTimeoutSeconds * 1000 > deadline) return "time_budget";
    const task = await claimTask(deps.pool, options.config, owner, leaseSeconds);
    if (!task) return "queue_empty";
    summary.claimed += 1;
    const stop = await runTask(deps, options, task, owner, deadline, summary);
    if (stop) return stop;
  }
}

const FAILURES: StopReason[] = ["model_unavailable", "model_error", "digest_mismatch", "error"];

/** Runs the AI stage. Everything it does is resumable, and stopping early loses nothing. */
export async function runMatch(deps: MatchDeps, options: MatchOptions): Promise<MatchSummary> {
  const { pool, log } = deps;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + options.timeBudgetSeconds * 1000;

  const leaseSeconds = options.inferenceTimeoutSeconds * 2 + 60;
  await retryTransient(() =>
    pool.query(
      `UPDATE match_runs SET status = 'failed', finished_at = now()
        WHERE status = 'running' AND started_at < now() - make_interval(secs => $1)`,
      [Math.max(options.timeBudgetSeconds, leaseSeconds) * 2],
    ),
  );
  const { rows } = await retryTransient(() =>
    pool.query(`INSERT INTO match_runs (trigger, summary) VALUES ($1, $2) RETURNING id`, [
      options.trigger,
      JSON.stringify({ configHash: hashMatchConfig(options.config) }),
    ]),
  );
  const runId: string = rows[0].id;
  const summary: MatchSummary = {
    runId,
    status: "succeeded",
    stopReason: "queue_empty",
    error: null,
    durationMs: 0,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    exhausted: 0,
    recovered: await recoverAbandoned(pool, options),
    validationRetries: 0,
    truncatedInputs: 0,
    superseded: 0,
    backlog: { pending: 0, due: 0, oldestAgeSeconds: null, exhausted: 0 },
  };

  try {
    if ((await countRunnable(pool, options.config)) > 0 && options.maxJobs > 0) {
      const verified = await verifyModel(deps.model, options.config);
      if (verified.ok) summary.stopReason = await drainQueue(deps, options, runId, deadline, summary);
      else {
        summary.stopReason = verified.reason;
        summary.error = verified.message;
      }
    }
  } catch (error) {
    summary.stopReason = "error";
    summary.error = String(error);
    log.error("Match stage failed", { error: summary.error });
  }

  summary.status = FAILURES.includes(summary.stopReason) ? "failed" : "succeeded";
  summary.backlog = await readBacklog(pool, options.config);
  summary.durationMs = now() - startedAt;
  await retryTransient(() =>
    pool.query(`UPDATE match_runs SET status = $2, finished_at = now(), summary = $3 WHERE id = $1`, [
      runId,
      summary.status,
      JSON.stringify(summary),
    ]),
  );
  return summary;
}
