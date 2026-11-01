import { z } from "zod";

const int = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

/**
 * Resource limits for a single worker run. Defaults are chosen from the hosted
 * measurements recorded in COSTS.md; change them there and here together.
 */
export const BudgetSchema = z.object({
  MAX_AI_JOBS_PER_RUN: int(8, 0, 500),
  AI_TIME_BUDGET_SECONDS: int(900, 0, 7200),
  AI_MINUTES_PER_MONTH: int(800, 0, 100_000),
  INFERENCE_TIMEOUT_SECONDS: int(330, 5, 1800),
  MAX_JOB_INPUT_TOKENS: int(1600, 100, 16000),
  MAX_OUTPUT_TOKENS: int(1000, 50, 4096),
  OLLAMA_NUM_CTX: int(3072, 512, 32768),
  MAX_HTTP_CONCURRENCY: int(4, 1, 32),
  MAX_BROWSER_PAGES_PER_RUN: int(0, 0, 200),
  CRAWL_TIME_BUDGET_SECONDS: int(300, 10, 3600),
});

export type Budget = z.infer<typeof BudgetSchema>;

export type EnvSource = Record<string, string | undefined>;

/** Actions expands an unset secret or variable to an empty string, which must mean "not set". */
export function withoutBlanks(env: EnvSource): EnvSource {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
}

export function loadBudget(env: EnvSource = process.env): Budget {
  return BudgetSchema.parse(withoutBlanks(env));
}
