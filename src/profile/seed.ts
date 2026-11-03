import type { MatchProfile } from "../match/prompt";

/**
 * The owner's search preferences, set from their CV: Staff Automation Engineer,
 * 15+ years, hands-on tech lead. Used only until a profile revision exists;
 * after that the profile is edited on /profile.
 */
export const SEED_MATCH_PROFILE: MatchProfile = {
  titles: [
    "Staff Automation Engineer",
    "Principal Automation Engineer",
    "Automation Tech Lead",
    "Test Infrastructure Engineer",
    "Senior QA Automation Engineer",
    "QA Automation Engineer",
    "Automation Engineer",
    "SDET",
    "Test Automation Developer",
  ],
  candidateExperienceYears: { min: 15, max: 20 },
  seniorities: ["Senior", "Staff", "Lead", "Principal"],
  requiredSkills: [],
  preferredSkills: [
    "TypeScript",
    "JavaScript",
    "Node.js",
    "Playwright",
    "WebdriverIO",
    "Selenium",
    "Java",
    "Python",
    "API testing",
    "E2E test frameworks",
    "CI/CD",
    "GitHub Actions",
    "Jenkins",
    "Docker",
    "Test architecture and strategy",
  ],
  preferredLocations: ["Modi'in", "Jerusalem", "Shephela", "Central Israel"],
  workArrangements: [],
  preferredIndustries: ["Banking", "Fintech", "Financial institutions", "Enterprise software", "Technology"],
  exclusions: ["Junior or entry-level roles", "Manual-only QA roles"],
};
