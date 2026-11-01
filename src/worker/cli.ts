/**
 * Worker entry point, used by scheduled workflows and by hand.
 *
 *   npm run worker -- migrate
 *   npm run worker -- seed
 *   npm run worker -- crawl [--trigger manual] [--mode incremental|full] [--provider lever] [--company Nanit]
 */
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadWorkerEnv } from "../config/env";
import { createPool } from "../db/pool";
import { migrate } from "../db/migrate";
import { HttpClient } from "../http/client";
import { crawl, dryRunCrawl, type CrawlOptions } from "../ingest/crawl";
import { seedCatalog } from "../ingest/seed";
import { createLogger, redact } from "../logger";

const ArgsSchema = z.object({
  trigger: z.string().min(1).default("manual"),
  mode: z.enum(["incremental", "full"]).default("incremental"),
  provider: z.enum(["greenhouse", "lever"]).optional(),
  company: z.string().min(1).optional(),
  "dry-run": z.boolean().default(false),
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
      default:
        console.error("Usage: worker <migrate|seed|crawl> [options]");
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
