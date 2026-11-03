/**
 * Scores the filter and the model against benchmarks/eval/dataset.json.
 *
 *   npx tsx benchmarks/eval/run.ts [--filter-only] [--out file.json]
 *
 * The labels are machine-proposed, so these numbers measure agreement with a
 * draft, not real-world quality. Human calibration is still outstanding.
 */
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadBudget } from "../../src/config/budget";
import { buildMatchConfig } from "../../src/match/config";
import { OllamaClient } from "../../src/match/ollama-client";
import { buildMatchMessages, prepareJobDescription, verifyEvidence } from "../../src/match/prompt";
import { parseModelOutput } from "../../src/match/runner";
import { deriveMatchResponse, modelOutputJsonSchema, STRONG_MATCH_SCORE } from "../../src/match/schema";
import { scoreFacts } from "../../src/match/facts";
import { evalProfile, factsForExample, filterExample, loadDataset } from "./lib";

const { values } = parseArgs({ options: { "filter-only": { type: "boolean" }, out: { type: "string" } } });

const config = buildMatchConfig({ ...loadBudget(), OLLAMA_MODEL: process.env.OLLAMA_MODEL, OLLAMA_MODEL_DIGEST: process.env.OLLAMA_MODEL_DIGEST });
const client = new OllamaClient(process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434");

const rows: Array<Record<string, unknown>> = [];
for (const example of loadDataset()) {
  const filter = filterExample(example);
  const row: Record<string, unknown> = {
    id: example.id,
    split: example.split,
    kind: example.kind,
    language: example.language,
    filterExpected: example.expected.filter,
    filterActual: filter.decision,
    reasons: filter.reasons,
    relevantExpected: example.expected.relevant,
    roleExpected: example.expected.role,
  };
  if (!values["filter-only"] && filter.decision === "eligible") {
    const input = prepareJobDescription(example.description, config.maxJobInputTokens);
    const job = { title: example.title, company: "Example Co", location: example.location, description: example.description };
    const chat = await client.chat({
      model: config.model,
      messages: buildMatchMessages(evalProfile, job, input),
      format: modelOutputJsonSchema,
      options: config.options,
      timeoutMs: 300_000,
    });
    const parsed = parseModelOutput(chat.content, chat.doneReason);
    row.outputTokens = chat.outputTokens;
    row.totalMs = chat.totalMs;
    if (parsed.ok) {
      const response = deriveMatchResponse(parsed.output, scoreFacts(evalProfile, factsForExample(example)));
      const evidence = verifyEvidence(parsed.output, `${example.title}\n${input.text}`);
      Object.assign(row, {
        score: response.score,
        recommendation: response.recommendation,
        roleActual: response.role_category,
        evidence: `${evidence.literal}/${evidence.total}`,
      });
    } else row.failure = parsed.kind;
  }
  rows.push(row);
  console.log(JSON.stringify(row));
}

function report(split: string) {
  const subset = rows.filter((row) => row.split === split);
  const scored = subset.filter((row) => row.score !== undefined);
  const alerted = subset.filter((row) => (row.score as number) >= STRONG_MATCH_SCORE);
  const relevant = subset.filter((row) => row.relevantExpected);
  return {
    split,
    examples: subset.length,
    filterAgreement: subset.filter((row) => row.filterExpected === row.filterActual).length,
    relevantRejectedByFilter: relevant.filter((row) => row.filterActual === "rejected").length,
    scored: scored.length,
    failures: subset.filter((row) => row.failure).length,
    roleAgreement: scored.filter((row) => row.roleExpected === row.roleActual).length,
    alerts: alerted.length,
    alertsOnRelevant: alerted.filter((row) => row.relevantExpected).length,
    relevantAlerted: relevant.filter((row) => (row.score as number) >= STRONG_MATCH_SCORE).length,
    relevantTotal: relevant.length,
  };
}

const summary = { humanReviewed: false, model: config.model, promptVersion: config.promptVersion, splits: [report("tune"), report("heldout")] };
console.log(JSON.stringify(summary, null, 2));
if (values.out) await writeFile(values.out, `${JSON.stringify({ summary, rows }, null, 1)}\n`);
