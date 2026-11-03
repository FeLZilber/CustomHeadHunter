import { describe, expect, it } from "vitest";
import { applyFilter, type FilterJob } from "../../src/filter";
import { MatchingProfileSchema } from "../../src/profile/schema";
import { SEED_MATCH_PROFILE } from "../../src/profile/seed";
import { filterExample, loadDataset } from "../../benchmarks/eval/lib";

const profile = MatchingProfileSchema.parse(SEED_MATCH_PROFILE);

const LONG_TEXT = "We build software for customers around the world and care about our people. ".repeat(6);

const job = (overrides: Partial<FilterJob> = {}): FilterJob => ({
  title: "QA Automation Engineer",
  descriptionText: LONG_TEXT,
  seniority: null,
  employmentType: null,
  technologies: [],
  experience: null,
  locations: [{ city: "Tel Aviv", region: "Center", country: "IL" }],
  remoteScope: null,
  ...overrides,
});

describe("applyFilter", () => {
  it("keeps QA titles in both languages", () => {
    for (const title of ["SDET", "Senior QA Engineer", "מהנדס/ת בדיקות", "Software Engineer in Test", "QA Lead"]) {
      expect(applyFilter(job({ title }), profile).decision, title).toBe("eligible");
    }
  });

  it("treats common title variations as QA", () => {
    for (const title of ["Test Development Engineer", "Test Developer", "Software Developer in Test", "בודקות תוכנה"]) {
      expect(applyFilter(job({ title }), profile).reasons, title).toContain("title_relevant");
    }
  });

  it("keeps a Hebrew quality title for the model to judge", () => {
    expect(applyFilter(job({ title: "מהנדס/ת איכות" }), profile).reasons).toContain("title_ambiguous");
  });

  it("keeps staff-level infrastructure titles for the model to judge", () => {
    const text = `${LONG_TEXT} Own our Playwright framework.`;
    for (const title of ["Staff Automation Engineer", "E2E Platform Engineer", "Developer Productivity Engineer", "Test Infrastructure Engineer"]) {
      expect(applyFilter(job({ title, descriptionText: text }), profile).decision, title).toBe("eligible");
    }
  });

  it("does not reject a senior job for asking 15 years of experience", () => {
    const experience = { level: "required", minYears: 15 } as never;
    expect(applyFilter(job({ title: "Staff Automation Engineer", experience }), profile).decision).toBe("eligible");
  });

  it("does not let JavaScript alone establish relevance", () => {
    const result = applyFilter(job({
      title: "Backend Developer",
      descriptionText: `${LONG_TEXT} JavaScript, TypeScript and Node.js.`,
      technologies: [{ name: "JavaScript", level: "required" } as never],
    }), profile);
    expect(result).toMatchObject({ decision: "rejected", reasons: ["no_qa_signal"] });
  });

  it("separates industrial automation from software test automation", () => {
    const title = "Automation Engineer";
    expect(applyFilter(job({ title, descriptionText: `${LONG_TEXT} Program PLC controllers and SCADA.` }), profile))
      .toMatchObject({ decision: "rejected", reasons: ["industrial_automation"] });
    const software = applyFilter(job({ title, descriptionText: `${LONG_TEXT} Write Playwright tests.` }), profile);
    expect(software.decision).toBe("eligible");
    expect(software.priority).toBeGreaterThan(applyFilter(job({ title }), profile).priority);
  });

  it("keeps an ambiguous title that shows no clear signal either way", () => {
    expect(applyFilter(job({ title: "Automation Engineer" }), profile).reasons).toContain("title_ambiguous");
  });

  it("does not match keywords inside longer words", () => {
    for (const title of ["Qatar Regional Manager", "Contest Coordinator", "Attestation Specialist"]) {
      expect(applyFilter(job({ title }), profile).decision, title).toBe("rejected");
    }
  });

  it("rejects other disciplines even when the text mentions testing", () => {
    const result = applyFilter(job({ title: "Sales Manager", descriptionText: `${LONG_TEXT} Sell test automation.` }), profile);
    expect(result).toMatchObject({ decision: "rejected", reasons: ["title_other_discipline"] });
  });

  it("keeps a non-QA title whose text is about test automation, at the lowest priority", () => {
    const result = applyFilter(job({ title: "Software Engineer", descriptionText: `${LONG_TEXT} Build our test automation.` }), profile);
    expect(result).toMatchObject({ decision: "eligible", priority: 0 });
  });

  it("rejects another engineering discipline that only mentions test tools", () => {
    const descriptionText = `${LONG_TEXT} We use Playwright and Cypress.`;
    for (const title of ["DevOps Team Lead", "Senior BI Engineer", "Full-Stack Developer", "Security Researcher", "Platform Engineering Team Leader"]) {
      expect(applyFilter(job({ title, descriptionText }), profile), title)
        .toMatchObject({ decision: "rejected", reasons: ["title_other_engineering"] });
    }
  });

  it("keeps a mixed title that names QA or automation", () => {
    const descriptionText = `${LONG_TEXT} We use Playwright and Cypress.`;
    for (const title of ["DevOps QA Engineer", "Backend Developer, Test Automation", "Full Stack Automation Engineer"]) {
      expect(applyFilter(job({ title, descriptionText }), profile).decision, title).toBe("eligible");
    }
  });

  it("does not reject a posting too short to judge", () => {
    expect(applyFilter(job({ title: "Software Engineer", descriptionText: "Join us." }), profile).reasons).toContain("description_too_short");
  });

  it("rejects experience only when a stated requirement is far above the candidate", () => {
    const mid = MatchingProfileSchema.parse({ ...SEED_MATCH_PROFILE, candidateExperienceYears: { min: 5, max: 8 } });
    const required = (minYears: number, level = "required") => ({ experience: { minYears, level } as never });
    expect(applyFilter(job(required(11)), mid)).toMatchObject({ decision: "eligible" });
    expect(applyFilter(job(required(12)), mid).reasons).toEqual(["experience_far_above_candidate"]);
    expect(applyFilter(job(required(20, "unspecified")), mid).decision).toBe("eligible");
    expect(applyFilter(job(), mid).reasons).toContain("experience_unknown");
  });

  it("rejects by location only when the job is clearly elsewhere", () => {
    expect(applyFilter(job({ locations: [], remoteScope: "other_country" }), profile).reasons).toEqual(["location_outside_israel"]);
    expect(applyFilter(job({ locations: [], remoteScope: "unstated" }), profile).decision).toBe("eligible");
    expect(applyFilter(job({ remoteScope: "other_country" }), profile).decision).toBe("eligible");
  });

  it("applies configured hard rules and leaves unknown facts eligible", () => {
    const strict = MatchingProfileSchema.parse({
      ...SEED_MATCH_PROFILE,
      hardRules: { excludedTitleTerms: ["Security"], excludedSeniorities: ["junior"], excludedRequiredTechnologies: ["Java"] },
    });
    expect(applyFilter(job({ employmentType: "internship" }), strict).reasons).toEqual(["excluded_employment_type"]);
    expect(applyFilter(job({ seniority: "junior" }), strict).reasons).toEqual(["excluded_seniority"]);
    expect(applyFilter(job({ title: "Security QA Engineer" }), strict).reasons).toEqual(["excluded_title_term"]);
    const java = (level: string) => ({ technologies: [{ name: "Java", level } as never] });
    expect(applyFilter(job(java("required")), strict).reasons).toEqual(["excluded_required_technology"]);
    expect(applyFilter(job(java("preferred")), strict).decision).toBe("eligible");
    expect(applyFilter(job(), strict).decision).toBe("eligible");
  });
});

describe("evaluation dataset", () => {
  it("agrees with the proposed filter labels and rejects no relevant job", () => {
    const disagreements = loadDataset()
      .filter((example) => filterExample(example).decision !== example.expected.filter)
      .map((example) => example.id);
    expect(disagreements).toEqual([]);
  });

  it("has the required coverage", () => {
    const examples = loadDataset();
    expect(examples).toHaveLength(20);
    for (const language of ["en", "he", "mixed"]) expect(examples.some((e) => e.language === language)).toBe(true);
    for (const kind of ["relevant", "irrelevant", "borderline", "ambiguous"]) expect(examples.some((e) => e.kind === kind)).toBe(true);
    expect(examples.filter((e) => e.split === "heldout")).toHaveLength(10);
  });
});
