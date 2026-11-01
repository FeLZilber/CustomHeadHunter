import { createHash } from "node:crypto";
import { z } from "zod";

const terms = z.array(z.string().trim().min(1)).default([]);

export const HardRulesSchema = z.object({
  excludedTitleTerms: terms,
  excludedEmploymentTypes: z.array(z.enum(["full_time", "part_time", "contract", "temporary", "internship"])).default(["internship"]),
  excludedSeniorities: z.array(z.enum(["junior", "mid", "senior", "lead", "principal", "manager"])).default([]),
  excludedRequiredTechnologies: terms,
  /** How far a stated requirement may exceed the candidate's experience before it is a clear mismatch. */
  maxExperienceGapYears: z.number().int().min(0).max(30).default(3),
});

/** Everything that can change a filter decision or a model answer. */
export const MatchingProfileSchema = z.object({
  titles: z.array(z.string().trim().min(1)).min(1),
  candidateExperienceYears: z.object({ min: z.number().min(0), max: z.number().min(0) }).nullable(),
  seniorities: terms,
  requiredSkills: terms,
  preferredSkills: terms,
  preferredLocations: terms,
  workArrangements: terms,
  salaryExpectation: z.object({ min: z.number().positive(), currency: z.string().min(1), period: z.string().min(1) }).nullable().default(null),
  preferredIndustries: terms,
  exclusions: terms,
  hardRules: HardRulesSchema.prefault({}),
});

export type MatchingProfile = z.infer<typeof MatchingProfileSchema>;

/** Delivery choices. Changing these must never cost an inference. */
export const PreferencesSchema = z.object({
  notificationThreshold: z.number().int().min(0).max(100).default(75),
});

export type Preferences = z.infer<typeof PreferencesSchema>;

export interface Profile {
  profileId: string;
  revisionId: string;
  revision: number;
  matching: MatchingProfile;
  matchingHash: string;
  preferences: Preferences;
}

/** Parsing fixes the key order, so stored jsonb and fresh input hash alike. */
export function hashMatchingProfile(matching: MatchingProfile): string {
  return createHash("sha256").update(JSON.stringify(MatchingProfileSchema.parse(matching))).digest("hex");
}
