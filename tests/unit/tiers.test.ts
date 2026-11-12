import { describe, expect, it } from "vitest";
import { classifyTier, TITLE_ONLY_REJECTIONS } from "../../src/filter/tiers";
import {
  DEFAULT_ADJACENT_TITLES,
  hashMatchingProfile,
  MatchingProfileSchema,
  PreferencesSchema,
} from "../../src/profile/schema";
import { SEED_MATCH_PROFILE } from "../../src/profile/seed";

const rejected = (title: string, ...reasons: string[]) => ({ decision: "rejected" as const, reasons, title });

describe("classifyTier", () => {
  it("is strict for an eligible job", () => {
    expect(classifyTier({ decision: "eligible", reasons: ["title_relevant"], title: "QA Engineer" }, [])).toBe("strict");
  });

  it("is adjacent for a DevOps title rejected only as another engineering role", () => {
    expect(classifyTier(rejected("Senior DevOps Engineer", "title_other_engineering"), DEFAULT_ADJACENT_TITLES)).toBe("adjacent");
  });

  it("is adjacent for a support engineering title rejected for lack of a QA signal", () => {
    expect(classifyTier(rejected("Technical Support Engineer", "no_qa_signal"), DEFAULT_ADJACENT_TITLES)).toBe("adjacent");
  });

  it("stays out when a hard rule also rejected the job", () => {
    for (const hard of [
      "location_outside_israel",
      "excluded_title_term",
      "excluded_employment_type",
      "excluded_seniority",
      "excluded_required_technology",
      "experience_far_above_candidate",
    ]) {
      expect(classifyTier(rejected("DevOps Engineer", "no_qa_signal", hard), DEFAULT_ADJACENT_TITLES), hard).toBeNull();
    }
  });

  it("stays out without adjacent terms, or for an unrelated title", () => {
    expect(classifyTier(rejected("DevOps Engineer", "no_qa_signal"), [])).toBeNull();
    expect(classifyTier(rejected("Office Manager", "title_other_discipline"), DEFAULT_ADJACENT_TITLES)).toBeNull();
    expect(classifyTier(rejected("DevOps Engineer"), DEFAULT_ADJACENT_TITLES)).toBeNull();
  });

  it("matches whole words and phrases only", () => {
    expect(classifyTier(rejected("Site Reliability Engineer", "no_qa_signal"), ["Site Reliability"])).toBe("adjacent");
    expect(classifyTier(rejected("SREx Engineer", "no_qa_signal"), ["SRE"])).toBeNull();
    expect(classifyTier(rejected("Pre-SRE Lead", "no_qa_signal"), ["SRE"])).toBe("adjacent");
    expect(classifyTier(rejected("Unsupported Engineer", "no_qa_signal"), ["Support Engineer"])).toBeNull();
  });

  it("ignores case, punctuation and Hebrew marks", () => {
    expect(classifyTier(rejected("Dev-Ops / S.R.E. Engineer", "no_qa_signal"), ["dev ops"])).toBe("adjacent");
    expect(classifyTier(rejected("DEVOPS!!", "no_qa_signal"), ["devops"])).toBe("adjacent");
    expect(classifyTier(rejected("מהנדס/ת דבאופס", "no_qa_signal"), ["דבאופס"])).toBe("adjacent");
    expect(classifyTier(rejected("מהנדס דבאופסים", "no_qa_signal"), ["דבאופס"])).toBeNull();
  });

  it("only treats role-only rejections as adjacent candidates", () => {
    expect(TITLE_ONLY_REJECTIONS).toEqual(["no_qa_signal", "title_other_discipline", "title_other_engineering", "industrial_automation", "hardware_discipline"]);
  });
});

describe("adjacent titles preference", () => {
  it("defaults on a stored preferences object that predates the field", () => {
    expect(PreferencesSchema.parse({ notificationThreshold: 80 })).toEqual({
      notificationThreshold: 80,
      adjacentTitles: DEFAULT_ADJACENT_TITLES,
    });
  });

  it("leaves the matching hash of an existing profile unchanged", () => {
    // Computed on master before the adjacent tier existed.
    expect(hashMatchingProfile(MatchingProfileSchema.parse(SEED_MATCH_PROFILE))).toBe(
      "1cef15766418a9c692d64eb2b4e2f077623da7719c61ae7caa635cec23b3bf37",
    );
  });
});
