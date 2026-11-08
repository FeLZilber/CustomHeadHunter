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
  /** Absent in caches written before the field existed; such a found board is re-probed. */
  israeliNamed: z.number().optional(),
  qaTitles: z.number(),
  checkedAt: z.string(),
});
export type CacheEntry = z.infer<typeof cacheEntrySchema>;
export type ProbeCache = Record<string, CacheEntry>;

export const cacheKey = (provider: Provider, providerKey: string): string => `${provider}:${providerKey}`;

/** Damaged or foreign entries are dropped one by one rather than trusted: the cache only saves requests. */
export function parseCache(text: string): ProbeCache {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const cache: ProbeCache = {};
  for (const [key, value] of Object.entries(raw)) {
    const entry = cacheEntrySchema.safeParse(value);
    if (entry.success) cache[key] = entry.data;
  }
  return cache;
}

export function isFresh(entry: CacheEntry, now: Date, maxAgeDays: number): boolean {
  if (entry.status === "found" && entry.israeliNamed === undefined) return false;
  const age = now.getTime() - Date.parse(entry.checkedAt);
  return Number.isFinite(age) && age >= 0 && age < maxAgeDays * 86_400_000;
}

/** Only definite answers are cached; an error says nothing about the board. */
export function toCacheEntry(result: ProbeResult, now: Date): CacheEntry | null {
  if (result.status === "error") return null;
  const { provider, providerKey, status, total, israeli, israeliNamed, qaTitles } = result;
  return { provider, providerKey, status, total, israeli, israeliNamed, qaTitles, checkedAt: now.toISOString() };
}

export function fromCacheEntry(entry: CacheEntry): ProbeResult {
  const { checkedAt: _checkedAt, israeliNamed, ...result } = entry;
  return { ...result, israeliNamed: israeliNamed ?? 0 };
}

/** The board that exists with the most Israeli jobs, then the most jobs overall. */
export function chooseBest(results: ProbeResult[]): ProbeResult | null {
  const found = results.filter((r) => r.status === "found");
  found.sort((a, b) => b.israeliNamed - a.israeliNamed || b.israeli - a.israeli || b.total - a.total);
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
    // A remote job open to Israel is in scope for the crawler but does not make an Israeli employer.
    return best.israeliNamed > 0
      ? { name, status: "found", board: best, detail: `${tag} ${best.israeliNamed}/${best.total} ${best.qaTitles} qa-like` }
      : { name, status: "no-il", board: best, detail: `${tag} ${best.israeliNamed}/${best.total} (${best.israeli} remote or in scope)` };
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
