/**
 * Worker entry point, used by scheduled workflows and by hand.
 *
 *   npm run worker -- migrate
 *   npm run worker -- seed
 *   npm run worker -- crawl [--trigger manual] [--mode incremental|full] [--provider lever] [--company Nanit]
 *   npm run worker -- evaluate
 *   npm run worker -- pending
 *   npm run worker -- match [--trigger manual] [--retry-failed] [--force-rematch]
 */
import { appendFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadWorkerEnv } from "../config/env";
import { createPool } from "../db/pool";
import { migrate } from "../db/migrate";
import { HttpClient } from "../http/client";
import { crawl, dryRunCrawl, type CrawlOptions } from "../ingest/crawl";
import { seedCatalog } from "../ingest/seed";
import { createLogger, redact } from "../logger";
import { buildMatchConfig } from "../match/config";
import { OllamaClient } from "../match/ollama-client";
import { countRunnable, evaluateJobs, forceRematch, recoverAbandoned, retryFailedTasks } from "../match/queue";
import { runMatch } from "../match/runner";
import { ensureProfile } from "../profile/store";

const ArgsSchema = z.object({
  trigger: z.string().min(1).default("manual"),
  mode: z.enum(["incremental", "full"]).default("incremental"),
  provider: z.enum(["greenhouse", "lever"]).optional(),
  company: z.string().min(1).optional(),
  "dry-run": z.boolean().default(false),
  "retry-failed": z.boolean().default(false),
  "force-rematch": z.boolean().default(false),
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
        log.info("Evaluation finished", { ...(await evaluateJobs(pool, buildMatchConfig(env), profile)) });
        return 0;
      }
      case "pending": {
        const policy = { maxAttempts: env.MAX_MATCH_ATTEMPTS, retryBaseSeconds: env.MATCH_RETRY_BASE_SECONDS };
        await recoverAbandoned(pool, policy);
        const pending = await countRunnable(pool, buildMatchConfig(env));
        log.info("Runnable match tasks", { pending });
        if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `pending=${pending}\n`);
        return 0;
      }
      case "match": {
        const config = buildMatchConfig(env);
        if (args["retry-failed"]) log.info("Failed tasks reopened", { tasks: await retryFailedTasks(pool) });
        if (args["force-rematch"]) log.info("Rematch requested", { tasks: await forceRematch(pool) });
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
      default:
        console.error("Usage: worker <migrate|seed|crawl|evaluate|pending|match> [options]");
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
