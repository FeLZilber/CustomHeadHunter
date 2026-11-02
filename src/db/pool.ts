import pg from "pg";

export type Pool = pg.Pool;
export type Queryable = Pick<pg.PoolClient, "query">;

export function createPool(connectionString: string, max = 4): Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000, // Neon resumes from scale-to-zero on first connect.
  });
  // Idle clients can be dropped by the provider; without a listener this crashes the process.
  pool.on("error", () => {});
  return pool;
}

const TRANSIENT_CODES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "53300", // too_many_connections
  "57P01", // admin_shutdown
  "57P02",
  "57P03",
  "08000",
  "08001",
  "08003",
  "08006",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

export function isTransientDbError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  return /connection terminated|timeout expired/i.test(error.message);
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retries transient database errors with exponential backoff and full jitter. */
export async function retryTransient<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts = 4, baseDelayMs = 250, sleep = defaultSleep } = options;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isTransientDbError(error)) throw error;
      await sleep(Math.random() * baseDelayMs * 2 ** (attempt - 1));
    }
  }
}

/** Runs a short transaction, retrying the whole unit on transient failure. Never put network calls inside. */
export function withTransaction<T>(
  pool: Pool,
  work: (client: pg.PoolClient) => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  return retryTransient(async () => {
    const client = await pool.connect();
    let failure: unknown;
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      failure = error;
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release(failure instanceof Error ? isTransientDbError(failure) : false);
    }
  }, options);
}
