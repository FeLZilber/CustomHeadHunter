import { describe, expect, it } from "vitest";
import {
  chooseBest, classify, extraSlugs, formatOutcome, isFresh, parseCache, parseCandidateLines, summarize, toCacheEntry,
} from "../../src/ingest/discover";
import type { ProbeResult } from "../../src/ingest/probe";

const board = (over: Partial<ProbeResult>): ProbeResult => ({
  provider: "greenhouse",
  providerKey: "acme",
  status: "found",
  total: 10,
  israeli: 2,
  israeliNamed: 2,
  qaTitles: 1,
  ...over,
});

describe("parseCandidateLines", () => {
  it("reads names, optional board URLs and notes, skipping comments and blanks", () => {
    const text = [
      "# header",
      "",
      "Wiz",
      "Acme Labs | https://jobs.lever.co/acme | from Dealroom",
      "Plain Co |  | just a note",
    ].join("\n");
    expect(parseCandidateLines(text)).toEqual([
      { name: "Wiz", boardUrl: null, note: null },
      { name: "Acme Labs", boardUrl: "https://jobs.lever.co/acme", note: "from Dealroom" },
      { name: "Plain Co", boardUrl: null, note: "just a note" },
    ]);
  });

  it("collapses duplicate names case-insensitively, keeping the first", () => {
    const result = parseCandidateLines("Wiz\nWIZ | https://x.test\r\nwiz");
    expect(result).toEqual([{ name: "Wiz", boardUrl: null, note: null }]);
  });
});

describe("chooseBest", () => {
  it("prefers more Israeli jobs, then more total, and ignores boards that were not found", () => {
    const a = board({ providerKey: "a", israeli: 3, israeliNamed: 3, total: 5 });
    const b = board({ providerKey: "b", israeli: 3, israeliNamed: 3, total: 50 });
    const c = board({ providerKey: "c", israeli: 1, israeliNamed: 1, total: 500 });
    const missing = board({ providerKey: "d", status: "missing", israeli: 99 });
    expect(chooseBest([a, c, missing, b])?.providerKey).toBe("b");
    expect(chooseBest([missing])).toBeNull();
    expect(chooseBest([])).toBeNull();
  });
});

describe("classify", () => {
  it("reports found, no-il, error and miss", () => {
    expect(classify("Acme", [board({})])).toMatchObject({ status: "found", detail: "greenhouse:acme 2/10 1 qa-like" });
    expect(classify("Acme", [board({ israeli: 0, israeliNamed: 0 })]).status).toBe("no-il");
    // Remote jobs open to Israel alone do not make an Israeli employer.
    expect(classify("Acme", [board({ israeli: 4, israeliNamed: 0 })]).status).toBe("no-il");
    expect(classify("Acme", [board({ status: "missing" })]).status).toBe("miss");
    expect(classify("Acme", [board({ status: "error", detail: "HTTP 500" }), board({ status: "missing" })]).status).toBe("error");
  });

  it("lets a found board outrank a failed guess", () => {
    expect(classify("Acme", [board({ status: "error" }), board({ providerKey: "acme2" })]).status).toBe("found");
  });
});

describe("formatting", () => {
  it("pads the status to a fixed width", () => {
    expect(formatOutcome(classify("Acme", [board({ status: "missing" })]))).toBe("miss   Acme");
    expect(formatOutcome(classify("Acme", [board({})]))).toBe("found  Acme  greenhouse:acme 2/10 1 qa-like");
  });

  it("counts statuses", () => {
    const outcomes = [classify("A", [board({})]), classify("B", [])];
    expect(summarize(outcomes)).toBe("2 companies: 1 found, 0 no-il, 1 miss, 0 skip, 0 error");
  });
});

describe("cache", () => {
  const now = new Date("2026-11-08T00:00:00Z");

  it("stores found and missing results but never errors", () => {
    expect(toCacheEntry(board({}), now)).toMatchObject({ status: "found", checkedAt: "2026-11-08T00:00:00.000Z" });
    expect(toCacheEntry(board({ status: "missing" }), now)?.status).toBe("missing");
    expect(toCacheEntry(board({ status: "error" }), now)).toBeNull();
  });

  it("treats entries younger than the max age as fresh", () => {
    const entry = toCacheEntry(board({}), new Date("2026-11-02T00:00:00Z"))!;
    expect(isFresh(entry, now, 7)).toBe(true);
    expect(isFresh(entry, now, 6)).toBe(false);
    expect(isFresh({ ...entry, checkedAt: "garbage" }, now, 7)).toBe(false);
    expect(isFresh({ ...entry, checkedAt: "2027-01-01T00:00:00Z" }, now, 7)).toBe(false);
  });

  it("round-trips through JSON and drops a damaged file", () => {
    const entry = toCacheEntry(board({}), now)!;
    expect(parseCache(JSON.stringify({ "greenhouse:acme": entry }))).toEqual({ "greenhouse:acme": entry });
    expect(parseCache("not json")).toEqual({});
    expect(parseCache(JSON.stringify({ x: { status: "found" } }))).toEqual({});
    expect(parseCache("")).toEqual({});
  });
});

describe("extraSlugs", () => {
  it("drops corporate suffixes and domains, and adds common board forms", () => {
    expect(extraSlugs("Oasis Security", ["oasissecurity", "oasis-security", "oasis_security"])).toEqual([
      "oasis", "oasisinc", "oasishq", "oasisio", "oasisai",
    ]);
    expect(extraSlugs("monday.com", ["mondaycom"])).toEqual(["monday", "mondayinc", "mondayhq", "mondayio", "mondayai"]);
  });

  it("never repeats a plain guess or returns slugs too short to be specific", () => {
    expect(extraSlugs("Wiz", ["wiz"])).toEqual(["wizinc", "wizhq", "wizio", "wizai"]);
    expect(extraSlugs("AI", ["ai"])).toEqual([]);
  });
});

describe("cache upgrades", () => {
  it("keeps valid entries when one is damaged, and re-probes a found board cached without israeliNamed", () => {
    const now = new Date("2026-11-08T12:00:00Z");
    const cache = parseCache(JSON.stringify({
      "greenhouse:old": { provider: "greenhouse", providerKey: "old", status: "found", total: 5, israeli: 2, qaTitles: 0, checkedAt: "2026-11-08T11:00:00Z" },
      "lever:gone": { provider: "lever", providerKey: "gone", status: "missing", total: 0, israeli: 0, qaTitles: 0, checkedAt: "2026-11-08T11:00:00Z" },
      "ashby:bad": { provider: "ashby", status: "found" },
    }));
    expect(Object.keys(cache).sort()).toEqual(["greenhouse:old", "lever:gone"]);
    expect(isFresh(cache["greenhouse:old"]!, now, 7)).toBe(false);
    expect(isFresh(cache["lever:gone"]!, now, 7)).toBe(true);
  });
});
