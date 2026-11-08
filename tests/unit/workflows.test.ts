import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Guards the triggers that keep production running. GitHub only registers a
 * schedule from the default branch and drops runs under load, so every
 * scheduled workflow needs a manual fallback, and the production ones carry a
 * backup cron. actionlint (CI `workflow-lint`) checks the syntax; this checks intent.
 */
const DIR = path.resolve(import.meta.dirname, "../../.github/workflows");
const PRODUCTION = ["discovery.yml", "maintenance.yml"];

interface Workflow {
  on?: { schedule?: { cron: string }[]; workflow_dispatch?: unknown } & Record<string, unknown>;
  concurrency?: { group?: string };
  jobs: Record<string, { if?: string }>;
}

const workflows = Object.fromEntries(
  readdirSync(DIR)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => [file, parse(readFileSync(path.join(DIR, file), "utf8")) as Workflow]),
);

const CRON_FIELD = /^(\*|\d+(-\d+)?(,\d+(-\d+)?)*)(\/\d+)?$/;

describe("workflow triggers", () => {
  it("finds the production workflows", () => {
    for (const file of PRODUCTION) expect(Object.keys(workflows)).toContain(file);
  });

  it.each(Object.entries(workflows).filter(([, wf]) => wf.on?.schedule))("%s can also be started by hand", (_file, wf) => {
    expect(wf.on).toHaveProperty("workflow_dispatch");
  });

  it.each(PRODUCTION)("%s has a primary and a backup cron", (file) => {
    const crons = workflows[file]!.on?.schedule?.map((entry) => entry.cron) ?? [];
    expect(crons.length).toBeGreaterThanOrEqual(2);
    expect(new Set(crons).size).toBe(crons.length);
    for (const cron of crons) {
      const fields = cron.trim().split(/\s+/);
      expect(fields, cron).toHaveLength(5);
      for (const field of fields) expect(field, cron).toMatch(CRON_FIELD);
    }
  });

  it.each(PRODUCTION)("%s shares the worker concurrency group, so a backup pass never overlaps", (file) => {
    expect(workflows[file]!.concurrency?.group).toBe("job-hunter-worker");
  });

  it.each(PRODUCTION)("%s keeps its production job behind PRODUCTION_ENABLED", (file) => {
    const gated = Object.values(workflows[file]!.jobs).filter((job) => job.if?.includes("vars.PRODUCTION_ENABLED == 'true'"));
    expect(gated.length).toBe(1);
  });

  it("runs the staleness drill only on request, with no production secrets", () => {
    const drill = (workflows["maintenance.yml"]!.jobs["staleness-drill"] ?? {}) as { if?: string; env?: Record<string, string> };
    expect(drill.if).toContain("inputs.drill");
    expect(JSON.stringify(drill)).not.toContain("secrets.");
  });
});
