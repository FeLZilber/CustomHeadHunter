import type { MatchProfile } from "../match/prompt";

/** The owner's supplied search preferences. This is not a verified resume. */
export const SEED_MATCH_PROFILE: MatchProfile = {
  titles: [
    "QA Automation Engineer",
    "Senior QA Automation Engineer",
    "Automation Engineer",
    "SDET",
    "Test Automation Developer",
  ],
  candidateExperienceYears: { min: 5, max: 8 },
  requiredSkills: [],
  preferredSkills: ["JavaScript", "TypeScript", "Playwright", "API testing", "Automation frameworks"],
  preferredLocations: ["Modi'in", "Jerusalem", "Shephela", "Central Israel"],
  workArrangements: [],
  preferredIndustries: ["Banking", "Fintech", "Financial institutions", "Enterprise software", "Technology"],
  exclusions: [],
};
