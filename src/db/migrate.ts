import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { withTransaction, type Pool } from "./pool";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../migrations");
const MIGRATION_LOCK_ID = 7_242_001;

/**
 * Applies pending migrations in filename order. Each file and its bookkeeping
 * row commit together, and a transaction-scoped lock serializes concurrent
 * runners without relying on a session surviving a pooled connection.
 */
export async function migrate(pool: Pool, directory = MIGRATIONS_DIR): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    const sql = await readFile(path.join(directory, file), "utf8");
    const ran = await withTransaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
      const existing = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (existing.rowCount) return false;
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      return true;
    });
    if (ran) applied.push(file);
  }
  return applied;
}
