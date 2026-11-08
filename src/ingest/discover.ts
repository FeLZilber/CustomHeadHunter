/** Pure logic behind scripts/discover-sources.ts, kept apart so it can be unit-tested. */
import { z } from "zod";
import type { Provider } from "../connectors/types";
import type { ProbeResult } from "./probe";

/** Words companies drop from their board slug: "Oasis Security" -> oasis, "monday.com" -> monday. */
const CORPORATE_SUFFIX = /\s+(?:technologies|technology|tech|ltd|inc|labs|security|software|systems|networks|group|io|ai|hq)$/i;

/**
 * Slugs worth a second try after the plain guesses miss: the name without a corporate suffix or
 * domain, and the forms boards commonly add ("wizinc", "snykhq"). Excludes the plain guesses.
 */
export function extraSlugs(name: string, plain: string[]): string[] {
  const base = name.trim().replace(/\.(?:com|io|ai|co)$/i, "").replace(CORPORATE_SUFFIX, "");
  const compact = base.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
  if (compact.length < 3) return []; // "AI" or "Q" is too unspecific to guess around.
  const words = base.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s-]/g, "").split(/[\s-]+/).filter(Boolean);
  const variants = [compact, words.join("-"), `${compact}inc`, `${compact}hq`, `${compact}io`, `${compact}ai`];
  return [...new Set(variants)].filter((slug) => slug.length >= 3 && !plain.includes(slug));
}

export interface Candidate {
  name: string;
  /** A pasted board or job link; used instead of slug guessing when it names a supported ATS. */
  boardUrl: string | null;
  note: string | null;
}

/**
 * `Company` or `Company | board URL or empty | note`. Blank lines and `#` comments are skipped;
 * a repeated name (case-insensitive) keeps its first line.
 */
export function parseCandidateLines(text: string): Candidate[] {
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [name = "", boardUrl = "", ...note] = line.split("|").map((part) => part.trim());
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    candidates.push({ name, boardUrl: boardUrl || null, note: note.join(" | ") || null });
  }
  return candidates;
}

// Any provider name is accepted: a cache written by a build with more providers must not discard the file.
const cacheEntrySchema = z.object({
  provider: z.string().transform((value) => value as Provider),
  providerKey: z.string(),
  status: z.enum(["found", "missing"]),
  total: z.number(),
  israeli: z.number(),
  qaTitles: z.number(),
  checkedAt: z.string(),
});
export type CacheEntry = z.infer<typeof cacheEntrySchema>;
export type ProbeCache = Record<string, CacheEntry>;

export const cacheKey = (provider: Provider, providerKey: string): string => `${provider}:${providerKey}`;

/** A damaged or foreign cache file is dropped rather than trusted: it only saves requests. */
export function parseCache(text: string): ProbeCache {
  try {
    const parsed = z.record(z.string(), cacheEntrySchema).safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function isFresh(entry: CacheEntry, now: Date, maxAgeDays: number): boolean {
  const age = now.getTime() - Date.parse(entry.checkedAt);
  return Number.isFinite(age) && age >= 0 && age < maxAgeDays * 86_400_000;
}

/** Only definite answers are cached; an error says nothing about the board. */
export function toCacheEntry(result: ProbeResult, now: Date): CacheEntry | null {
  if (result.status === "error") return null;
  const { provider, providerKey, status, total, israeli, qaTitles } = result;
  return { provider, providerKey, status, total, israeli, qaTitles, checkedAt: now.toISOString() };
}

export function fromCacheEntry(entry: CacheEntry): ProbeResult {
  const { checkedAt: _checkedAt, ...result } = entry;
  return result;
}

/** The board that exists with the most Israeli jobs, then the most jobs overall. */
export function chooseBest(results: ProbeResult[]): ProbeResult | null {
  const found = results.filter((r) => r.status === "found");
  found.sort((a, b) => b.israeli - a.israeli || b.total - a.total);
  return found[0] ?? null;
}

export type OutcomeStatus = "found" | "no-il" | "miss" | "skip" | "error";

export interface Outcome {
  name: string;
  status: OutcomeStatus;
  board: ProbeResult | null;
  detail: string;
}

/** Turns one company's probe results into a verdict. A board that was found outranks failed guesses. */
export function classify(name: string, results: ProbeResult[]): Outcome {
  const best = chooseBest(results);
  if (best) {
    const tag = cacheKey(best.provider, best.providerKey);
    return best.israeli > 0
      ? { name, status: "found", board: best, detail: `${tag} ${best.israeli}/${best.total} ${best.qaTitles} qa-like` }
      : { name, status: "no-il", board: best, detail: `${tag} 0/${best.total}` };
  }
  const failed = results.find((r) => r.status === "error");
  if (failed) {
    return { name, status: "error", board: null, detail: `${cacheKey(failed.provider, failed.providerKey)} ${failed.detail ?? "failed"}` };
  }
  return { name, status: "miss", board: null, detail: "" };
}

export const skipped = (name: string, detail: string): Outcome => ({ name, status: "skip", board: null, detail });

/** Fixed-width status first so a long run scans like a table. */
export function formatOutcome(outcome: Outcome): string {
  return `${outcome.status.padEnd(6)} ${outcome.name}${outcome.detail ? `  ${outcome.detail}` : ""}`;
}

export function summarize(outcomes: Outcome[]): string {
  const count = (status: OutcomeStatus) => outcomes.filter((o) => o.status === status).length;
  return `${outcomes.length} compan${outcomes.length === 1 ? "y" : "ies"}: ${count("found")} found, ${count("no-il")} no-il, ${count("miss")} miss, ${count("skip")} skip, ${count("error")} error`;
}
