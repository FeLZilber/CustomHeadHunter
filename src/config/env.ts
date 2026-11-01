import { z } from "zod";
import { BudgetSchema } from "./budget";

const booleanFlag = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((value) => value === "true" || value === "1");

const WorkerEnvSchema = BudgetSchema.extend({
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DRY_RUN: booleanFlag,
  OLLAMA_BASE_URL: z.url().default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().min(1).optional(),
  OLLAMA_MODEL_DIGEST: z.string().min(1).optional(),
  MAX_MATCH_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  MATCH_RETRY_BASE_SECONDS: z.coerce.number().int().min(0).max(86400).default(1800),
  FRESHNESS_GRACE_SNAPSHOTS: z.coerce.number().int().min(1).max(20).default(2),
  SUSPICIOUS_DROP_RATIO: z.coerce.number().min(0).max(1).default(0.5),
  SIGNIFICANT_CHANGE_FIELDS: z
    .string()
    .default("title,locations,workArrangement,seniority,technologies,experience,salary")
    .transform((value) => value.split(",").map((field) => field.trim()).filter(Boolean)),
});

export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;

export function loadWorkerEnv(env: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return WorkerEnvSchema.parse(env);
}
