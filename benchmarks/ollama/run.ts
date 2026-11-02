/**
 * Measures Ollama matching latency and output validity with the production
 * prompt, schema and client. See OLLAMA_SETUP.md for the procedure.
 *
 *   npx tsx benchmarks/ollama/run.ts --label local-m2pro --passes 1
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import { loadBudget } from "../../src/config/budget";
import { buildMatchConfig } from "../../src/match/config";
import { OllamaClient, OllamaError, type ChatResult } from "../../src/match/ollama-client";
import { buildMatchMessages, prepareJobDescription, verifyEvidence } from "../../src/match/prompt";
import { deriveMatchResponse, modelOutputJsonSchema, ModelOutputSchema } from "../../src/match/schema";
import { SEED_MATCH_PROFILE } from "../../src/profile/seed";

const run = promisify(execFile);

const SamplesSchema = z.object({
  samples: z.array(
    z.object({
      id: z.string(),
      language: z.enum(["english", "hebrew", "mixed"]),
      title: z.string(),
      company: z.string(),
      location: z.string(),
      description: z.string(),
    }),
  ),
});

const { values: args } = parseArgs({
  options: {
    label: { type: "string", default: "unlabelled" },
    model: { type: "string", default: process.env.OLLAMA_MODEL ?? "qwen2.5:3b" },
    "base-url": { type: "string", default: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434" },
    samples: { type: "string", default: "benchmarks/ollama/samples.json" },
    passes: { type: "string", default: "1" },
    "time-budget-seconds": { type: "string", default: "1200" },
    "docker-container": { type: "string" },
    out: { type: "string", default: "benchmarks/out/result.json" },
  },
});

interface Attempt {
  sample: string;
  language: string;
  pass: number;
  wallMs: number;
  outcome: "ok" | "invalid_json" | "invalid_schema" | "truncated_output" | "timeout" | "error";
  error: string | null;
  truncatedInput: boolean;
  doneReason: string | null;
  promptTokens: number;
  estimatedTokens: number;
  outputTokens: number;
  outputTokensPerSecond: number | null;
  loadMs: number;
  promptMs: number;
  score: number | null;
  recommendation: string | null;
  evidenceTotal: number;
  evidenceLiteral: number;
  output: string;
}

interface MemorySample {
  atMs: number;
  containerMiB: number | null;
  hostAvailableMiB: number;
}

const parseMiB = (value: string): number | null => {
  const match = /^([\d.]+)\s*(KiB|MiB|GiB)/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  return match[2] === "GiB" ? amount * 1024 : match[2] === "KiB" ? amount / 1024 : amount;
};

async function hostAvailableMiB(): Promise<number> {
  try {
    const meminfo = await readFile("/proc/meminfo", "utf8");
    const match = /MemAvailable:\s+(\d+) kB/.exec(meminfo);
    if (match) return Math.round(Number(match[1]) / 1024);
  } catch {
    // Not Linux; os.freemem is the closest available signal.
  }
  return Math.round(os.freemem() / 1024 / 1024);
}

function startMemorySampler(container: string | undefined, startedAt: number) {
  const samples: MemorySample[] = [];
  let stopped = false;
  const tick = async () => {
    let containerMiB: number | null = null;
    if (container) {
      try {
        const { stdout } = await run("docker", ["stats", "--no-stream", "--format", "{{.MemUsage}}", container]);
        containerMiB = parseMiB(stdout);
      } catch {
        containerMiB = null;
      }
    }
    samples.push({ atMs: Date.now() - startedAt, containerMiB, hostAvailableMiB: await hostAvailableMiB() });
    if (!stopped) setTimeout(tick, 5000);
  };
  void tick();
  return {
    samples,
    stop: () => {
      stopped = true;
    },
  };
}

const percentile = (values: number[], fraction: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? null;
};

function summarize(attempts: Attempt[]) {
  const completed = attempts.filter((attempt) => attempt.outcome !== "timeout" && attempt.outcome !== "error");
  const wall = completed.map((attempt) => attempt.wallMs);
  const count = (outcome: Attempt["outcome"]) => attempts.filter((attempt) => attempt.outcome === outcome).length;
  const evidenceTotal = attempts.reduce((sum, attempt) => sum + attempt.evidenceTotal, 0);
  const evidenceLiteral = attempts.reduce((sum, attempt) => sum + attempt.evidenceLiteral, 0);
  const rates = attempts.flatMap((attempt) => (attempt.outputTokensPerSecond ? [attempt.outputTokensPerSecond] : []));
  return {
    attempts: attempts.length,
    ok: count("ok"),
    invalidJson: count("invalid_json"),
    invalidSchema: count("invalid_schema"),
    truncatedOutput: count("truncated_output"),
    timeouts: count("timeout"),
    errors: count("error"),
    medianMs: percentile(wall, 0.5),
    p90Ms: percentile(wall, 0.9),
    maxMs: wall.length ? Math.max(...wall) : null,
    medianOutputTokens: percentile(attempts.map((attempt) => attempt.outputTokens), 0.5),
    medianPromptTokens: percentile(attempts.map((attempt) => attempt.promptTokens), 0.5),
    medianOutputTokensPerSecond: percentile(rates, 0.5),
    evidenceTotal,
    evidenceLiteral,
  };
}

async function main() {
  const budget = loadBudget();
  const passes = Number(args.passes);
  const timeBudgetMs = Number(args["time-budget-seconds"]) * 1000;
  const model = args.model!;
  const client = new OllamaClient(args["base-url"]!);
  const { samples } = SamplesSchema.parse(JSON.parse(await readFile(args.samples!, "utf8")));
  const disk = await statfs(process.cwd());
  const startedAt = Date.now();
  const memory = startMemorySampler(args["docker-container"], startedAt);

  const inferenceOptions = buildMatchConfig(budget).options;
  const attempts: Attempt[] = [];
  let stoppedEarly = false;

  outer: for (let pass = 0; pass < passes; pass += 1) {
    for (const sample of samples) {
      if (Date.now() - startedAt + budget.INFERENCE_TIMEOUT_SECONDS * 1000 > timeBudgetMs) {
        stoppedEarly = true;
        break outer;
      }
      const input = prepareJobDescription(sample.description, budget.MAX_JOB_INPUT_TOKENS);
      const messages = buildMatchMessages(SEED_MATCH_PROFILE, sample, input);
      const began = Date.now();
      const attempt: Attempt = {
        sample: sample.id,
        language: sample.language,
        pass,
        wallMs: 0,
        outcome: "error",
        error: null,
        truncatedInput: input.truncated,
        doneReason: null,
        promptTokens: 0,
        estimatedTokens: input.estimatedTokens,
        outputTokens: 0,
        outputTokensPerSecond: null,
        loadMs: 0,
        promptMs: 0,
        score: null,
        recommendation: null,
        evidenceTotal: 0,
        evidenceLiteral: 0,
        output: "",
      };
      let result: ChatResult | null = null;
      try {
        result = await client.chat({
          model,
          messages,
          format: modelOutputJsonSchema,
          options: inferenceOptions,
          timeoutMs: budget.INFERENCE_TIMEOUT_SECONDS * 1000,
          keepAlive: "30m",
        });
      } catch (error) {
        attempt.outcome = error instanceof OllamaError && error.kind === "timeout" ? "timeout" : "error";
        attempt.error = String(error);
      }
      attempt.wallMs = Date.now() - began;
      if (result) {
        attempt.doneReason = result.doneReason;
        attempt.promptTokens = result.promptTokens;
        attempt.outputTokens = result.outputTokens;
        attempt.output = result.content;
        attempt.loadMs = result.loadMs;
        attempt.promptMs = result.promptMs;
        attempt.outputTokensPerSecond = result.outputMs
          ? Math.round((result.outputTokens / result.outputMs) * 10000) / 10
          : null;
        attempt.outcome = classify(result, attempt, `${sample.title}\n${sample.location}\n${sample.description}`);
      }
      attempts.push(attempt);
      console.log(
        `${sample.id} pass=${pass} ${attempt.outcome} ${attempt.wallMs}ms ` +
          `prompt=${attempt.promptTokens} output=${attempt.outputTokens} score=${attempt.score}`,
      );
    }
  }
  memory.stop();

  const containerPeaks = memory.samples.flatMap((sample) => (sample.containerMiB ? [sample.containerMiB] : []));
  const report = {
    label: args.label,
    measuredAt: new Date().toISOString(),
    provenance: "Synthetic postings; timings and validity are measured, relevance is not assessed.",
    environment: {
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      cpuCount: os.cpus().length,
      memoryMiB: Math.round(os.totalmem() / 1024 / 1024),
      diskFreeGiB: Math.round((disk.bavail * disk.bsize) / 1024 ** 3),
      nodeVersion: process.version,
    },
    model,
    modelDigest: await client.modelDigest(model).catch(() => null),
    ollamaVersion: await client.version().catch(() => null),
    inferenceOptions,
    limits: budget,
    samples: samples.length,
    passes,
    stoppedEarly,
    durationMs: Date.now() - startedAt,
    firstAttemptLoadMs: attempts[0]?.loadMs ?? null,
    firstAttemptWallMs: attempts[0]?.wallMs ?? null,
    warm: summarize(attempts.slice(1)),
    byLanguage: Object.fromEntries(
      ["english", "hebrew", "mixed"].map((language) => [
        language,
        summarize(attempts.slice(1).filter((attempt) => attempt.language === language)),
      ]),
    ),
    memory: {
      peakContainerMiB: containerPeaks.length ? Math.round(Math.max(...containerPeaks)) : null,
      minHostAvailableMiB: Math.min(...memory.samples.map((sample) => sample.hostAvailableMiB)),
      sampleCount: memory.samples.length,
    },
    attempts,
  };
  await mkdir(path.dirname(args.out!), { recursive: true });
  await writeFile(args.out!, `${JSON.stringify(report, null, 2)}\n`);
  const { attempts: _omitted, ...headline } = report;
  console.log(JSON.stringify(headline, null, 2));
}

function classify(result: ChatResult, attempt: Attempt, sourceText: string): Attempt["outcome"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.content);
  } catch (error) {
    attempt.error = String(error).slice(0, 200);
    return result.doneReason === "length" ? "truncated_output" : "invalid_json";
  }
  const validated = ModelOutputSchema.safeParse(parsed);
  if (!validated.success) {
    attempt.error = validated.error.message.slice(0, 400);
    return "invalid_schema";
  }
  const response = deriveMatchResponse(validated.data);
  attempt.score = response.score;
  attempt.recommendation = response.recommendation;
  const evidence = verifyEvidence(validated.data, sourceText);
  attempt.evidenceTotal = evidence.total;
  attempt.evidenceLiteral = evidence.literal;
  return "ok";
}

await main();
