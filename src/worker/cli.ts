/**
 * Worker entry point, used by scheduled workflows and by hand.
 *
 *   npm run worker -- migrate
 *   npm run worker -- seed
 *   npm run worker -- adopt
 *   npm run worker -- crawl [--trigger manual] [--mode incremental|full] [--provider lever] [--company Nanit]
 *   npm run worker -- evaluate
 *   npm run worker -- requeue [--retry-failed] [--force-rematch]
 *   npm run worker -- pending
 *   npm run worker -- match [--trigger manual]
 *   npm run worker -- notify [--trigger manual] [--dry-run] [--rematch-digest] [--retry-ambiguous] [--retry-failed]
 *   npm run worker -- cleanup
 *   npm run worker -- health [--fail-on-stale] [--alert]
 */
import { appendFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadWorkerEnv } from "../config/env";
import { createPool } from "../db/pool";
import { migrate } from "../db/migrate";
import { HttpClient } from "../http/client";
import { crawl, dryRunCrawl, type CrawlOptions } from "../ingest/crawl";
import { adoptRequestedSources } from "../ingest/requests";
import { seedCatalog } from "../ingest/seed";
import { createLogger, redact } from "../logger";
import { buildMatchConfig, hashMatchConfig } from "../match/config";
import { OllamaClient } from "../match/ollama-client";
import { countAffordable, countRunnable, evaluateJobs, forceRematch, recoverAbandoned, retryFailedTasks } from "../match/queue";
import { runMatch } from "../match/runner";
import { buildRelevance, startEpoch } from "../notify/outbox";
import { runNotify } from "../notify/sender";
import { TelegramClient } from "../notify/telegram";
import { ensureProfile } from "../profile/store";
import { cleanup, healthAlerts, readHealth, renderAlerts, renderHealth } from "./maintenance";

const ArgsSchema = z.object({
  trigger: z.string().min(1).default("manual"),
  mode: z.enum(["incremental", "full"]).default("incremental"),
  provider: z.enum(["greenhouse", "lever", "ashby", "workable", "jsonld", "workday"]).optional(),
  company: z.string().min(1).optional(),
  "dry-run": z.boolean().default(false),
  "retry-failed": z.boolean().default(false),
  "force-rematch": z.boolean().default(false),
  "rematch-digest": z.boolean().default(false),
  "retry-ambiguous": z.boolean().default(false),
  "fail-on-stale": z.boolean().default(false),
  alert: z.boolean().default(false),
});

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      trigger: { type: "string" },
      mode: { type: "string" },
      provider: { type: "string" },
      company: { type: "string" },
      "dry-run": { type: "boolean" },
      "retry-failed": { type: "boolean" },
      "force-rematch": { type: "boolean" },
      "rematch-digest": { type: "boolean" },
      "retry-ambiguous": { type: "boolean" },
      "fail-on-stale": { type: "boolean" },
      alert: { type: "boolean" },
    },
  });
  const args = ArgsSchema.parse(values);
  const env = loadWorkerEnv();
  const log = createLogger(env.LOG_LEVEL);
  const pool = createPool(env.DATABASE_URL);

  try {
    switch (positionals[0]) {
      case "migrate":
        log.info("Migrations applied", { applied: await migrate(pool) });
        return 0;
      case "seed":
        log.info("Catalog seeded", { ...(await seedCatalog(pool)) });
        return 0;
      case "adopt":
        log.info("Requested sources checked", { ...(await adoptRequestedSources(pool, new HttpClient())) });
        return 0;
      case "crawl": {
        const options: CrawlOptions = {
          trigger: args.trigger,
          mode: args.mode,
          filter: { provider: args.provider, company: args.company },
          concurrency: env.MAX_HTTP_CONCURRENCY,
          timeBudgetSeconds: env.CRAWL_TIME_BUDGET_SECONDS,
          leaseSeconds: Math.max(120, env.CRAWL_TIME_BUDGET_SECONDS),
          significantFields: env.SIGNIFICANT_CHANGE_FIELDS,
          graceSnapshots: env.FRESHNESS_GRACE_SNAPSHOTS,
          suspiciousDropRatio: env.SUSPICIOUS_DROP_RATIO,
        };
        const deps = { pool, http: new HttpClient(), log };
        if (args["dry-run"] || env.DRY_RUN) {
          log.info("Dry run finished", { sources: await dryRunCrawl(deps, options) });
          return 0;
        }
        const summary = await crawl(deps, options);
        log.info("Crawl finished", { ...summary });
        return summary.status === "failed" ? 1 : 0;
      }
      case "evaluate": {
        const profile = await ensureProfile(pool);
        log.info("Evaluation finished", { ...(await evaluateJobs(pool, buildMatchConfig(env), profile, env.AI_QUEUE_LIMIT)) });
        return 0;
      }
      case "requeue": {
        if (args["retry-failed"]) log.info("Failed tasks reopened", { tasks: await retryFailedTasks(pool) });
        if (args["force-rematch"]) {
          await startEpoch(pool, buildRelevance(await ensureProfile(pool), buildMatchConfig(env)), "force_rematch");
          log.info("Rematch requested", { tasks: await forceRematch(pool) });
        }
        return 0;
      }
      case "pending": {
        const policy = { maxAttempts: env.MAX_MATCH_ATTEMPTS, retryBaseSeconds: env.MATCH_RETRY_BASE_SECONDS };
        await recoverAbandoned(pool, policy);
        const { pending, runnable, minutesUsed } = await countAffordable(pool, buildMatchConfig(env), env.AI_MINUTES_PER_MONTH);
        log.info("Runnable match tasks", { pending, minutesUsed });
        if (pending < runnable) log.warn("Monthly AI budget used; tasks wait for next month", { runnable, minutesUsed });
        if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `pending=${pending}\n`);
        return 0;
      }
      case "match": {
        const config = buildMatchConfig(env);
        if (args["dry-run"] || env.DRY_RUN) {
          log.info("Dry run finished", { pending: await countRunnable(pool, config) });
          return 0;
        }
        const summary = await runMatch(
          { pool, model: new OllamaClient(env.OLLAMA_BASE_URL), log },
          {
            trigger: args.trigger,
            config,
            maxJobs: env.MAX_AI_JOBS_PER_RUN,
            timeBudgetSeconds: env.AI_TIME_BUDGET_SECONDS,
            inferenceTimeoutSeconds: env.INFERENCE_TIMEOUT_SECONDS,
            maxAttempts: env.MAX_MATCH_ATTEMPTS,
            retryBaseSeconds: env.MATCH_RETRY_BASE_SECONDS,
          },
        );
        log.info("Match finished", { ...summary });
        return summary.status === "failed" ? 1 : 0;
      }
      case "notify": {
        const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId } = env;
        const reopen = [
          ...(args["retry-ambiguous"] ? (["ambiguous"] as const) : []),
          ...(args["retry-failed"] ? (["failed"] as const) : []),
        ];
        const summary = await runNotify(
          { pool, sender: token && chatId ? new TelegramClient(token, chatId) : null, log },
          {
            trigger: args.trigger,
            relevance: buildRelevance(await ensureProfile(pool), buildMatchConfig(env)),
            dryRun: args["dry-run"] || env.DRY_RUN,
            maxAlerts: env.MAX_ALERTS_PER_RUN,
            maxDigests: env.MAX_DIGESTS_PER_RUN,
            digestSize: env.DIGEST_SIZE,
            maxAttempts: env.MAX_NOTIFY_ATTEMPTS,
            retryBaseSeconds: env.NOTIFY_RETRY_BASE_SECONDS,
            timeBudgetSeconds: env.NOTIFY_TIME_BUDGET_SECONDS,
            rematchDigest: args["rematch-digest"],
            reopen,
          },
        );
        log.info("Notify finished", { ...summary });
        return summary.status === "failed" ? 1 : 0;
      }
      case "cleanup": {
        log.info("Cleanup finished", { ...(await cleanup(pool, env.RETENTION_DAYS)) });
        return 0;
      }
      case "health": {
        const health = await readHealth(pool, hashMatchConfig(buildMatchConfig(env)), env.STALE_DISCOVERY_HOURS);
        const report = renderHealth(health);
        console.log(report);
        if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
        const alerts = healthAlerts(health, env.AI_MINUTES_PER_MONTH);
        if (args.alert && alerts.length > 0) {
          // Best effort: a failed warning must not hide the health result.
          if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) log.warn("Health alerts not sent: Telegram is not configured", { alerts: alerts.length });
          else {
            const outcome = await new TelegramClient(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID).send(renderAlerts(alerts));
            log.info("Health alerts sent", { alerts: alerts.length, outcome: outcome.kind });
          }
        }
        return args["fail-on-stale"] && health.discoveryStale ? 1 : 0;
      }
      default:
        console.error("Usage: worker <migrate|seed|adopt|crawl|evaluate|requeue|pending|match|notify|cleanup|health> [options]");
        return 2;
    }
  } finally {
    await pool.end();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(redact(String(error)));
  process.exitCode = 1;
}
