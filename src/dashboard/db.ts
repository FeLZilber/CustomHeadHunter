import "server-only";
import { createPool, type Pool } from "../db/pool";
import { loadDashboardEnv } from "./env";

const shared = globalThis as { dashboardPool?: Pool };

/** One small pool per server instance. Serverless instances multiply, so production uses Neon's pooled endpoint. */
export function dashboardPool(): Pool {
  shared.dashboardPool ??= createPool(loadDashboardEnv().DATABASE_URL, 3);
  return shared.dashboardPool;
}
