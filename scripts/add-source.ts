/**
 * Finds a company's public job board and adds it to catalog/sources.json.
 *
 *   npm run catalog:add -- "Check Point" --industry cybersecurity
 *   npm run catalog:add -- "Acme" --provider greenhouse --key acme-inc --industry fintech
 *   npm run catalog:add -- --file candidates.txt --industry fintech --dry-run
 *
 * A source is added only when its board answers and holds at least one Israeli listing
 * (the catalog's stated bar). Without --provider/--key it guesses slugs on every provider.
 * Reads public APIs only, through the same rate-limited client as the crawler.
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { HttpClient } from "../src/http/client";
import { careerUrl } from "../src/ingest/board-url";
import { CATALOG_PATH } from "../src/ingest/seed";
import { discoverBoards, PROVIDERS, probeBoard, verificationUrl, type ProbeResult } from "../src/ingest/probe";
import type { Provider } from "../src/connectors/types";

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

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    industry: { type: "string" },
    provider: { type: "string" },
    key: { type: "string" },
    "career-url": { type: "string" },
    file: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

const names = [...positionals];
if (values.file) {
  const lines = (await readFile(values.file, "utf8")).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  names.push(...lines);
}
if (names.length === 0 || !values.industry) {
  console.error('usage: catalog:add "Company" [...] --industry <industry> [--provider p --key k] [--file list.txt] [--dry-run]');
  process.exit(2);
}
if (values.provider && !PROVIDERS.includes(values.provider as Provider)) {
  console.error(`--provider must be one of ${PROVIDERS.join(", ")}`);
  process.exit(2);
}
if ((values.key || values.provider) && names.length > 1) {
  console.error("--provider/--key apply to a single company");
  process.exit(2);
}

const catalog = JSON.parse(await readFile(CATALOG_PATH, "utf8")) as { notes: string; sources: CatalogEntry[] };
const taken = new Set(catalog.sources.map((s) => `${s.provider}:${s.providerKey}`));
const companies = new Set(catalog.sources.map((s) => s.company.toLowerCase()));
const http = new HttpClient();

let added = 0;
for (const name of names) {
  if (companies.has(name.toLowerCase())) {
    console.log(`skip     ${name}: already in the catalog`);
    continue;
  }
  let best: ProbeResult | undefined;
  if (values.provider && values.key) {
    const result = await probeBoard(http, values.provider as Provider, values.key);
    if (result.status === "found") best = result;
    else console.log(`miss     ${name}: ${result.status} ${result.detail ?? ""}`);
  } else {
    const providers = values.provider ? [values.provider as Provider] : PROVIDERS;
    best = (await discoverBoards(http, name, providers))[0];
  }
  if (!best) {
    console.log(`miss     ${name}: no public board found (try --provider/--key if you know the slug)`);
    continue;
  }
  const tag = `${best.provider}:${best.providerKey}`;
  if (best.israeliNamed === 0) {
    console.log(`no-il    ${name}: ${tag} has ${best.total} jobs, none in Israel scope`);
    continue;
  }
  if (taken.has(tag)) {
    console.log(`skip     ${name}: ${tag} is already in the catalog`);
    continue;
  }
  console.log(`${values["dry-run"] ? "would-add" : "add     "} ${name}: ${tag} — ${best.israeli}/${best.total} Israeli, ${best.qaTitles} QA-like`);
  taken.add(tag);
  companies.add(name.toLowerCase());
  catalog.sources.push({
    company: name,
    industry: values.industry,
    provider: best.provider,
    providerKey: best.providerKey,
    careerUrl: values["career-url"] ?? careerUrl(best),
    countryCoverage: ["IL"],
    enabled: true,
    verifiedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    verificationSourceUrl: verificationUrl(best.provider, best.providerKey),
  });
  added += 1;
}

if (added > 0 && !values["dry-run"]) {
  await writeFile(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
}
console.log(`${values["dry-run"] ? "would add" : "added"} ${added} source(s); catalog now ${catalog.sources.length}`);
