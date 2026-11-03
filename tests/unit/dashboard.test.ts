import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { safeHref } from "../../src/app/_components/format";
import { allowSignIn, isOwner } from "../../src/dashboard/owner";
import { parseProfileForm } from "../../src/dashboard/profile-form";
import { parseFilters } from "../../src/dashboard/queries";
import { MatchingProfileSchema } from "../../src/profile/schema";
import { SEED_MATCH_PROFILE } from "../../src/profile/seed";

describe("owner check", () => {
  it("accepts only the configured numeric id", () => {
    expect(isOwner("1001", "1001")).toBe(true);
    expect(isOwner("1002", "1001")).toBe(false);
    expect(isOwner("10010", "1001")).toBe(false);
  });

  it.each([undefined, null, "", 1001, {}, ["1001"], true])("rejects %j as an identity", (value) => {
    expect(isOwner(value, "1001")).toBe(false);
  });

  it("allows sign-in from GitHub only, and only for the owner", () => {
    expect(allowSignIn("github", 1001, "1001")).toBe(true);
    expect(allowSignIn("github", "1001", "1001")).toBe(true);
    expect(allowSignIn("github", 1002, "1001")).toBe(false);
    expect(allowSignIn("github", ["1001"], "1001")).toBe(false);
    expect(allowSignIn("email", 1001, "1001")).toBe(false);
    expect(allowSignIn(undefined, 1001, "1001")).toBe(false);
  });
});

describe("job filters", () => {
  it("falls back on bad values instead of failing a bookmarked link", () => {
    expect(parseFilters({ status: "nope", match: "x", sort: "y", page: "-1", minScore: "500" })).toMatchObject({
      status: "active",
      match: "all",
      sort: "best",
      page: 1,
      minScore: undefined,
    });
  });

  it("keeps Hebrew terms and takes the first of a repeated parameter", () => {
    expect(parseFilters({ q: [" בודק תוכנה ", "ignored"] }).q).toBe("בודק תוכנה");
  });

  it("treats blank fields from an empty form as absent", () => {
    expect(parseFilters({ q: "", company: "", minScore: "" })).toMatchObject({ q: undefined, company: undefined, minScore: undefined });
  });
});

describe("profile form", () => {
  const current = MatchingProfileSchema.parse(SEED_MATCH_PROFILE);

  function form(overrides: Record<string, string> = {}) {
    const data = new FormData();
    const fields = {
      titles: "QA Engineer\nSDET, Test Automation",
      experienceMin: "2",
      experienceMax: "4",
      notificationThreshold: "80",
      ...overrides,
    };
    for (const [name, value] of Object.entries(fields)) data.set(name, value);
    return data;
  }

  it("splits lists on commas and lines", () => {
    const result = parseProfileForm(form(), current);
    expect(result).toMatchObject({ ok: true, preferences: { notificationThreshold: 80 } });
    if (result.ok) expect(result.matching.titles).toEqual(["QA Engineer", "SDET", "Test Automation"]);
  });

  it("keeps settings the form does not show", () => {
    const result = parseProfileForm(form({ excludedTitleTerms: "Intern" }), current);
    if (!result.ok) throw new Error("expected a valid form");
    expect(result.matching.hardRules.excludedTitleTerms).toEqual(["Intern"]);
    expect(result.matching.hardRules.maxExperienceGapYears).toBe(current.hardRules.maxExperienceGapYears);
  });

  it("clears optional values left blank", () => {
    const result = parseProfileForm(form({ experienceMin: "", experienceMax: "" }), current);
    if (!result.ok) throw new Error("expected a valid form");
    expect(result.matching.candidateExperienceYears).toBeNull();
    expect(result.matching.salaryExpectation).toBeNull();
  });

  it.each([
    [{ titles: " , " }, "titles"],
    [{ experienceMin: "5", experienceMax: "2" }, "candidateExperienceYears"],
    [{ experienceMin: "5", experienceMax: "" }, "candidateExperienceYears"],
    [{ salaryMin: "-5", salaryCurrency: "ILS", salaryPeriod: "month" }, "salaryExpectation"],
    [{ notificationThreshold: "101" }, "notificationThreshold"],
    [{ notificationThreshold: "" }, "notificationThreshold"],
  ])("names the bad field for %j", (overrides, field) => {
    expect(parseProfileForm(form(overrides), current)).toEqual({ ok: false, field });
  });
});

describe("posting links", () => {
  it.each(["https://example.test/jobs/1", "http://example.test/1"])("allows %s", (url) => {
    expect(safeHref(url)).toBe(url);
  });

  it.each(["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "not a url", ""])("refuses %j", (url) => {
    expect(safeHref(url)).toBeNull();
  });
});

describe("authorization coverage", () => {
  const appDir = path.resolve("src/app");
  const pages = readdirSync(appDir, { recursive: true, encoding: "utf8" }).filter((file) => path.basename(file) === "page.tsx");

  it("finds the pages", () => {
    expect(pages.length).toBeGreaterThanOrEqual(6);
  });

  it.each(pages.filter((file) => !file.startsWith("denied")))("%s checks the owner before anything else", (file) => {
    const source = readFileSync(path.join(appDir, file), "utf8");
    const body = /export default async function \w+\([^)]*\)[^{]*\{\s*([^\n]*)/.exec(source);
    expect(body?.[1]).toBe("await requireOwner();");
  });

  it("gives the public denied page no data access", () => {
    const source = readFileSync(path.join(appDir, "denied/page.tsx"), "utf8");
    expect(source).not.toMatch(/dashboard\/(db|queries)/);
  });

  it("checks the owner first in every server action", () => {
    const source = readFileSync(path.join(appDir, "actions.ts"), "utf8");
    const actions = [...source.matchAll(/export async function (\w+)\([^)]*\) \{\n\s*([^\n]*)/g)];
    expect(actions.map(([, name]) => name)).toEqual(["toggleSaved", "toggleApplied", "dismissJob", "toggleMissed", "updateProfile"]);
    for (const [, , first] of actions) expect(first).toBe("await requireOwner();");
    expect(source.match(/^export /gm)).toHaveLength(actions.length);
  });

  it("renders no raw HTML anywhere", () => {
    const files = readdirSync(appDir, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".tsx"));
    for (const file of files) expect(readFileSync(path.join(appDir, file), "utf8")).not.toContain("dangerouslySetInnerHTML");
  });
});
