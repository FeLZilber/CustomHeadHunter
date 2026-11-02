import { z } from "zod";
import { withoutBlanks, type EnvSource } from "../config/budget";

const DashboardEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  NEXTAUTH_SECRET: z.string().min(32),
  GITHUB_ID: z.string().min(1),
  GITHUB_SECRET: z.string().min(1),
  OWNER_GITHUB_ID: z.string().regex(/^\d+$/, "OWNER_GITHUB_ID must be the numeric GitHub user id"),
  STALE_DISCOVERY_HOURS: z.coerce.number().int().min(1).max(720).default(30),
});

export type DashboardEnv = z.infer<typeof DashboardEnvSchema>;

/** Read per request rather than at import, because `next build` runs without these. */
export function loadDashboardEnv(env: EnvSource = process.env): DashboardEnv {
  return DashboardEnvSchema.parse(withoutBlanks(env));
}
