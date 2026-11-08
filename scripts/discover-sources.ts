/**
 * Finds verified public job boards for many company names.
 *
 *   npm run catalog:discover -- --file candidates.txt
 *   npm run catalog:discover -- --file candidates.txt --industry fintech --write
 *
 * Each line of the file is `Company` or `Company | board URL or empty | source note`.
 * A dry run by default; catalog/sources.json changes only with --write, and then only for
 * boards that a fresh live probe still shows with at least one Israeli job.
 * Probe results are cached (found and missing only) so an interrupted run resumes cheaply.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import type { Provider } from "../src/connectors/types";
import { HttpClient } from "../src/http/client";
import { careerUrl, parseBoardUrl, type BoardRef } from "../src/ingest/board-url";
import {
  cacheKey, classify, extraSlugs, formatOutcome, fromCacheEntry, isFresh, parseCache, parseCandidateLines,
  skipped, summarize, toCacheEntry, type Candidate, type Outcome, type ProbeCache,
} from "../src/ingest/discover";
import { PROVIDERS, probeBoard, slugCandidates, verificationUrl, type ProbeResult } from "../src/ingest/probe";
import { CATALOG_PATH } from "../src/ingest/seed";

interface CatalogEntry {
  company: string;
  industry: string;
  provider: Provider;
  providerKey: string;
  careerUrl: string;
  countryCoverage: string[];
  enabled: boolean;
  verifiedAt: string;
  verificationSourceUrl: string;
}

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    write: { type: "boolean", default: false },
    industry: { type: "string", default: "technology" },
    providers: { type: "string" },
    cache: { type: "string", default: ".cache/discover-sources.json" },
    "max-age-days": { type: "string", default: "7" },
    report: { type: "string" },
    "extra-slugs": { type: "boolean", default: false },
    "extra-providers": { type: "string", default: "greenhouse,ashby" },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

if (!values.file) fail("usage: catalog:discover --file <list.txt> [--write] [--industry x] [--providers greenhouse,lever,ashby] [--cache path] [--max-age-days n] [--report path] [--extra-slugs [--extra-providers greenhouse,ashby]]");
// Workable rate-limits bulk lookups (429, then a Retry-After over a minute), so it is probed only on request.
const BULK_PROVIDERS = PROVIDERS.filter((p) => p !== "workable");
const providers = (values.providers ?? BULK_PROVIDERS.join(",")).split(",").map((p) => p.trim()).filter(Boolean);
for (const p of providers) if (!PROVIDERS.includes(p as Provider)) fail(`--providers must be from ${PROVIDERS.join(", ")}`);
const extraProviders = values["extra-slugs"]
  ? values["extra-providers"]!.split(",").map((p) => p.trim()).filter(Boolean)
  : [];
for (const p of extraProviders) if (!PROVIDERS.includes(p as Provider)) fail(`--extra-providers must be from ${PROVIDERS.join(", ")}`);
const maxAgeDays = Number(values["max-age-days"]);
if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) fail("--max-age-days must be a non-negative number");
const cachePath = values.cache!;

const candidates = parseCandidateLines(await readFile(values.file, "utf8"));
const catalog = JSON.parse(await readFile(CATALOG_PATH, "utf8")) as { notes: string; sources: CatalogEntry[] };
const takenBoards = new Set(catalog.sources.map((s) => cacheKey(s.provider, s.providerKey)));
const takenNames = new Set(catalog.sources.map((s) => s.company.toLowerCase()));
const cache: ProbeCache = parseCache(await readFile(cachePath, "utf8").catch(() => ""));
const http = new HttpClient();

async function saveCache(): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
}

/** Cached answer when fresh; otherwise a live probe, remembered if it was definite. */
async function probeCached(board: BoardRef): Promise<ProbeResult> {
  const key = cacheKey(board.provider, board.providerKey);
  const hit = cache[key];
  if (hit && isFresh(hit, new Date(), maxAgeDays)) return fromCacheEntry(hit);
  const result = await probeBoard(http, board.provider, board.providerKey);
  const entry = toCacheEntry(result, new Date());
  if (entry) cache[key] = entry;
  return result;
}

/** Boards worth trying for a candidate: the pasted link if it is a supported ATS, else slug guesses. */
function boardsFor(candidate: Candidate): BoardRef[][] {
  const given = candidate.boardUrl ? parseBoardUrl(candidate.boardUrl) : null;
  if (given) return [[given]];
  // One group per slug: slugs run in order, the providers within a group run together.
  return slugCandidates(candidate.name).map((providerKey) => providers.map((provider) => ({ provider: provider as Provider, providerKey })));
}

async function discover(candidate: Candidate): Promise<Outcome> {
  const groups = boardsFor(candidate);
  const taken = groups.flat().find((b) => takenBoards.has(cacheKey(b.provider, b.providerKey)));
  if (takenNames.has(candidate.name.toLowerCase())) return skipped(candidate.name, "already in the catalog");
  if (taken) return skipped(candidate.name, `${cacheKey(taken.provider, taken.providerKey)} is already in the catalog`);
  const results: ProbeResult[] = [];
  for (const group of groups) results.push(...(await Promise.all(group.map(probeCached))));
  const first = classify(candidate.name, results);
  // --extra-slugs: a second, narrower round of guesses, only when the plain ones found no board at all.
  if (first.status !== "miss" || extraProviders.length === 0 || candidate.boardUrl) return first;
  for (const providerKey of extraSlugs(candidate.name, slugCandidates(candidate.name))) {
    const group = extraProviders.map((provider) => ({ provider: provider as Provider, providerKey }));
    if (group.some((b) => takenBoards.has(cacheKey(b.provider, b.providerKey)))) continue;
    results.push(...(await Promise.all(group.map(probeCached))));
  }
  return classify(candidate.name, results);
}

const outcomes: Outcome[] = [];
for (const candidate of candidates) {
  const outcome = await discover(candidate);
  outcomes.push(outcome);
  console.log(formatOutcome(outcome));
  await saveCache();
}
console.log(summarize(outcomes));

if (values.report) {
  const report = outcomes.map(({ name, status, board, detail }, i) => ({
    name,
    status,
    note: candidates[i]!.note,
    provider: board?.provider ?? null,
    providerKey: board?.providerKey ?? null,
    israeli: board?.israeli ?? null,
    israeliNamed: board?.israeliNamed ?? null,
    total: board?.total ?? null,
    qaTitles: board?.qaTitles ?? null,
    detail,
  }));
  await mkdir(path.dirname(values.report), { recursive: true });
  await writeFile(values.report, `${JSON.stringify(report, null, 2)}\n`);
}

if (values.write) {
  let added = 0;
  for (const outcome of outcomes) {
    if (outcome.status !== "found" || !outcome.board) continue;
    const { provider, providerKey } = outcome.board;
    const tag = cacheKey(provider, providerKey);
    // Another company in this run may have claimed the same board.
    if (takenBoards.has(tag)) continue;
    const live = await probeBoard(http, provider, providerKey); // Never trust the cache for what gets written.
    if (live.status !== "found" || live.israeliNamed === 0) {
      console.log(`drop   ${outcome.name}  ${tag} no longer shows an Israeli job (${live.status})`);
      continue;
    }
    takenBoards.add(tag);
    catalog.sources.push({
      company: outcome.name,
      industry: values.industry!,
      provider,
      providerKey,
      careerUrl: careerUrl({ provider, providerKey }),
      countryCoverage: ["IL"],
      enabled: true,
      verifiedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      verificationSourceUrl: verificationUrl(provider, providerKey),
    });
    console.log(`add    ${outcome.name}  ${tag} ${live.israeliNamed}/${live.total}`);
    added += 1;
  }
  if (added > 0) await writeFile(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`added ${added} source(s); catalog now ${catalog.sources.length}`);
}
