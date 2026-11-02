import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { migrate } from "../../src/db/migrate";
import { createPool } from "../../src/db/pool";
import { BASE_URL, NEXTAUTH_SECRET, OWNER_ID, PORT } from "./constants";
import { seedFixtures } from "./seed";

/** A throwaway database and the production build, with fixed test credentials. CI supplies its own Postgres. */
async function startDatabase() {
  if (process.env.TEST_DATABASE_URL) return { url: process.env.TEST_DATABASE_URL, stop: async () => {} };
  const root = path.resolve(".test-postgres");
  await mkdir(root, { recursive: true });
  const databaseDir = await mkdtemp(path.join(root, "e2e-"));
  const port = 55000 + (process.pid % 1000);
  const server = new EmbeddedPostgres({ databaseDir, user: "test", password: "test", port, persistent: false, onLog: () => {} });
  await server.initialise();
  await server.start();
  await server.createDatabase("e2e");
  return {
    url: `postgres://test:test@127.0.0.1:${port}/e2e`,
    stop: async () => {
      await server.stop();
      await rm(databaseDir, { recursive: true, force: true });
    },
  };
}

const database = await startDatabase();
const pool = createPool(database.url);
await migrate(pool);
await seedFixtures(pool);
await pool.end();

const app = spawn("npx", ["next", "start", "--hostname", "127.0.0.1", "--port", String(PORT)], {
  stdio: "inherit",
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    NEXTAUTH_URL: BASE_URL,
    NEXTAUTH_SECRET,
    DATABASE_URL: database.url,
    GITHUB_ID: "e2e-client-id",
    GITHUB_SECRET: "e2e-client-secret",
    OWNER_GITHUB_ID: OWNER_ID,
  },
});

async function shutdown() {
  app.kill();
  await database.stop();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
app.on("exit", shutdown);
