import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/** CI supplies TEST_DATABASE_URL from a service container. Elsewhere a throwaway server is started. */
export default async function setup(project: TestProject) {
  const external = process.env.TEST_DATABASE_URL;
  let databaseUrl = external;
  let stop: () => Promise<void> = async () => {};

  if (!databaseUrl) {
    const root = path.resolve(".test-postgres");
    await mkdir(root, { recursive: true });
    const databaseDir = await mkdtemp(path.join(root, "run-"));
    const port = 54000 + (process.pid % 1000);
    const server = new EmbeddedPostgres({
      databaseDir,
      user: "test",
      password: "test",
      port,
      persistent: false,
      onLog: () => {},
      onError: () => {},
    });
    await server.initialise();
    await server.start();
    await server.createDatabase("headhunter_test");
    databaseUrl = `postgres://test:test@127.0.0.1:${port}/headhunter_test`;
    stop = async () => {
      await server.stop();
      await rm(databaseDir, { recursive: true, force: true });
    };
  }

  const pool = createPool(databaseUrl);
  await migrate(pool);
  await pool.end();
  project.provide("databaseUrl", databaseUrl);
  return stop;
}
