import { describe, expect, it } from "vitest";
import { RUBRIC_MAX, scoreExperience, scoreFacts, scoreIndustry, scoreLocation, scoreSeniority, scoreSkills } from "../../src/match/facts";
import { SEED_MATCH_PROFILE } from "../../src/profile/seed";

const profile = SEED_MATCH_PROFILE; // Staff-level, 15-20 years, Modi'in / Jerusalem / Shephela / Central Israel.
const tech = (name: string, level: "required" | "preferred" | "unspecified" = "required") => ({ name, level, evidence: name });
const place = (city: string | null, region: string) => ({ city, region, country: "IL" as const });

describe("scoreExperience", () => {
  const needs = (minYears: number, level: "required" | "preferred" | "unspecified" = "required") => ({ minYears, level, evidence: "" });
  it("gives full points when the candidate meets the requirement, and falls with the gap", () => {
    expect(scoreExperience(profile, needs(5))).toBe(15);
    expect(scoreExperience(profile, needs(20))).toBe(15);
    expect(scoreExperience(profile, needs(22))).toBe(10);
    expect(scoreExperience(profile, needs(25))).toBe(4);
    expect(scoreExperience(profile, needs(30))).toBe(0);
  });
  it("stays neutral when the posting states nothing firm", () => {
    expect(scoreExperience(profile, null)).toBe(8);
    expect(scoreExperience(profile, needs(30, "unspecified"))).toBe(8);
    expect(scoreExperience({ ...profile, candidateExperienceYears: null }, needs(5))).toBe(8);
  });
});

describe("scoreSeniority", () => {
  it("rewards the candidate's own level, including staff as principal", () => {
    for (const level of ["senior", "lead", "principal"] as const) expect(scoreSeniority(profile, level), level).toBe(10);
  });
  it("punishes roles below the candidate and is neutral when unstated", () => {
    expect(scoreSeniority(profile, "mid")).toBe(4);
    expect(scoreSeniority(profile, "junior")).toBe(0);
    expect(scoreSeniority(profile, "manager")).toBe(2);
    expect(scoreSeniority(profile, null)).toBe(6);
    expect(scoreSeniority({ ...profile, seniorities: [] }, "junior")).toBe(6);
  });
  it("gives a stretch role above the candidate's level most of the points", () => {
    expect(scoreSeniority({ ...profile, seniorities: ["Senior"] }, "principal")).toBe(7);
  });
});

describe("scoreLocation", () => {
  it("prefers a named city, then a preferred region, then any Israeli place", () => {
    expect(scoreLocation(profile, [place("Modi'in", "Shephela")], null)).toBe(10);
    expect(scoreLocation(profile, [place("Tel Aviv", "Central Israel")], null)).toBe(8);
    expect(scoreLocation(profile, [place("Haifa", "North")], null)).toBe(4);
  });
  it("takes the best of several places", () => {
    expect(scoreLocation(profile, [place("Haifa", "North"), place("Jerusalem", "Jerusalem")], null)).toBe(10);
  });
  it("treats an Israel-compatible remote job as good and no information as neutral", () => {
    expect(scoreLocation(profile, [], "israel")).toBe(7);
    expect(scoreLocation(profile, [], null)).toBe(5);
  });
});

describe("scoreSkills", () => {
  it("weights required technologies double and scales to the maximum", () => {
    expect(scoreSkills(profile, [tech("Playwright"), tech("TypeScript")])).toBe(RUBRIC_MAX.skills);
    expect(scoreSkills(profile, [tech("Playwright"), tech("Rust")])).toBe(13); // 2 of 4 weight
    expect(scoreSkills(profile, [tech("Rust", "required"), tech("Playwright", "preferred")])).toBe(8); // 1 of 3
    expect(scoreSkills(profile, [tech("Rust")])).toBe(0);
  });
  it("is neutral when no technology was detected", () => {
    expect(scoreSkills(profile, [])).toBe(13);
  });
  it("matches names whole, so Java does not match JavaScript", () => {
    const javaOnly = { ...profile, requiredSkills: [], preferredSkills: ["Java"] };
    expect(scoreSkills(javaOnly, [tech("JavaScript")])).toBe(0);
    expect(scoreSkills(javaOnly, [tech("Java")])).toBe(RUBRIC_MAX.skills);
  });
});

describe("scoreIndustry", () => {
  it("rewards a preferred industry and is neutral otherwise", () => {
    expect(scoreIndustry(profile, "fintech")).toBe(5);
    expect(scoreIndustry(profile, "enterprise software")).toBe(5);
    expect(scoreIndustry(profile, "biotech")).toBe(2);
    expect(scoreIndustry(profile, null)).toBe(2);
  });
});

describe("scoreFacts", () => {
  it("scores a posting that fits the CV close to the maximum", () => {
    const points = scoreFacts(profile, {
      seniority: "principal",
      experience: { minYears: 8, level: "required", evidence: "" },
      technologies: [tech("Playwright"), tech("TypeScript"), tech("Docker", "preferred")],
      locations: [place("Modi'in", "Shephela")],
      remoteScope: null,
      industry: "fintech",
    });
    expect(points).toEqual({ skills: 25, experience: 15, seniority: 10, location: 10, industry: 5 });
  });
  it("never exceeds the rubric maxima", () => {
    const points = scoreFacts(profile, { seniority: "senior", experience: null, technologies: [], locations: [], remoteScope: null, industry: null });
    for (const key of Object.keys(points) as Array<keyof typeof points>) expect(points[key]).toBeLessThanOrEqual(RUBRIC_MAX[key]);
  });
});
