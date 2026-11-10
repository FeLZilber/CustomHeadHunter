import { execFileSync } from "node:child_process";
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

interface Step {
  uses?: string;
  with?: Record<string, unknown>;
}

interface Workflow {
  on?: { schedule?: { cron: string }[]; workflow_dispatch?: unknown } & Record<string, unknown>;
  concurrency?: { group?: string };
  jobs: Record<string, { if?: string; "timeout-minutes"?: number; steps?: Step[] }>;
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

  // Two workflows once triggered on `mvp` after it was deleted, and silently stopped running.
  it.each(Object.entries(workflows).filter(([, wf]) => wf.on?.push))("%s triggers on pushes to master only", (_file, wf) => {
    const push = wf.on!.push as { branches?: string[] } | null;
    expect(push?.branches).toEqual(["master"]);
  });

  it("runs the staleness drill only on request, with no production secrets", () => {
    const drill = (workflows["maintenance.yml"]!.jobs["staleness-drill"] ?? {}) as { if?: string; env?: Record<string, string> };
    expect(drill.if).toContain("inputs.drill");
    expect(JSON.stringify(drill)).not.toContain("secrets.");
  });
});

const jobs = Object.entries(workflows).flatMap(([file, wf]) => Object.entries(wf.jobs).map(([name, job]) => ({ file, name, job })));

describe("workflow jobs", () => {
  const pipelineJobs = jobs.filter(({ job }) => job.steps?.some((step) => step.uses === "./.github/actions/pipeline"));

  it("finds the jobs that run the pipeline", () => {
    expect(pipelineJobs.map(({ file }) => file).sort()).toEqual(["discovery.yml", "maintenance.yml", "pipeline-smoke.yml"]);
  });

  // The action sizes the match stage from job-minutes, so notify still runs before the job times out.
  it.each(pipelineJobs.map(({ file, name, job }) => [`${file} ${name}`, job] as const))("%s passes its own timeout as job-minutes", (_label, job) => {
    const step = job.steps!.find((entry) => entry.uses === "./.github/actions/pipeline")!;
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    expect(String(step.with?.["job-minutes"])).toBe(String(job["timeout-minutes"]));
  });

  // Install scripts and other steps must not find the token in .git/config.
  it.each(jobs.filter(({ job }) => job.steps).map(({ file, name, job }) => [`${file} ${name}`, job] as const))(
    "%s checks out without persisting credentials",
    (_label, job) => {
      for (const step of job.steps!.filter((entry) => entry.uses?.startsWith("actions/checkout@"))) {
        expect(step.with?.["persist-credentials"]).toBe(false);
      }
    },
  );
});

describe("match budget", () => {
  const script = path.resolve(import.meta.dirname, "../../.github/actions/pipeline/match-budget.sh");
  const NOW = 1_000_000;
  const plan = (secondsLeft: number, aiSeconds: number, setAside = 0) =>
    execFileSync("bash", [script, String(NOW + secondsLeft), String(aiSeconds), String(setAside)], {
      env: { ...process.env, NOW: String(NOW), INFERENCE_TIMEOUT_SECONDS: "330" },
      encoding: "utf8",
    }).trim();

  it("keeps the full budget and stage deadline when there is time", () => {
    expect(plan(5000, 900)).toBe("900 1290");
  });

  it("trims the budget and stage deadline to the time left", () => {
    expect(plan(700, 900)).toBe("640 700");
  });

  it("sets time aside for the model to start", () => {
    expect(plan(700, 900, 180)).toBe("460 520");
  });

  it("skips matching when one inference no longer fits", () => {
    expect(plan(389, 900)).toBe("0 0");
    expect(plan(390, 900)).toBe("330 390");
    expect(plan(-60, 900)).toBe("0 0");
  });

  it("skips matching when the configured budget is below one inference", () => {
    expect(plan(5000, 100)).toBe("0 0");
  });
});

describe("pinned images", () => {
  // Dependabot updates docker-compose.yml but not the lock, which Actions uses.
  it("docker-compose runs the Ollama image in the model lock", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const lock = JSON.parse(readFileSync(path.join(root, "ollama/model-lock.json"), "utf8")) as { ollamaImage: string };
    const compose = parse(readFileSync(path.join(root, "docker-compose.yml"), "utf8")) as { services: Record<string, { image?: string }> };
    expect(compose.services.ollama?.image).toBe(lock.ollamaImage);
  });
});
