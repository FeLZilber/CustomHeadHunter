import { MatchingProfileSchema, PreferencesSchema, type MatchingProfile, type Preferences } from "../profile/schema";

const LIST_FIELDS = [
  "titles",
  "seniorities",
  "requiredSkills",
  "preferredSkills",
  "preferredLocations",
  "workArrangements",
  "preferredIndustries",
  "exclusions",
] as const;

export type ListField = (typeof LIST_FIELDS)[number];

export const FIELD_LABELS: Record<string, string> = {
  titles: "Target titles",
  candidateExperienceYears: "Experience",
  salaryExpectation: "Salary expectation",
  notificationThreshold: "Notification threshold",
  adjacentTitles: "Adjacent roles",
  excludedTitleTerms: "Excluded title terms",
};

export type ProfileFormResult =
  | { ok: true; matching: MatchingProfile; preferences: Preferences }
  | { ok: false; field: string };

const list = (data: FormData, name: string) =>
  String(data.get(name) ?? "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

const value = (data: FormData, name: string) => String(data.get(name) ?? "").trim();

const number = (text: string) => (text === "" ? Number.NaN : Number(text));

/** Starts from the current profile, so settings the form does not show survive an edit. */
export function parseProfileForm(data: FormData, current: MatchingProfile): ProfileFormResult {
  const years = [value(data, "experienceMin"), value(data, "experienceMax")];
  const noYears = years.every((text) => text === "");
  const salary = value(data, "salaryMin");
  const candidate = {
    ...current,
    ...Object.fromEntries(LIST_FIELDS.map((field) => [field, list(data, field)])),
    candidateExperienceYears: noYears ? null : { min: number(years[0]!), max: number(years[1]!) },
    salaryExpectation:
      salary === "" ? null : { min: number(salary), currency: value(data, "salaryCurrency"), period: value(data, "salaryPeriod") },
    hardRules: { ...current.hardRules, excludedTitleTerms: list(data, "excludedTitleTerms") },
  };
  if (!noYears && number(years[0]!) > number(years[1]!)) return { ok: false, field: "candidateExperienceYears" };

  const matching = MatchingProfileSchema.safeParse(candidate);
  if (!matching.success) {
    const path = matching.error.issues[0]?.path ?? [];
    const field = path.find((part): part is string => typeof part === "string" && part in FIELD_LABELS);
    return { ok: false, field: field ?? "titles" };
  }
  const preferences = PreferencesSchema.safeParse({
    notificationThreshold: number(value(data, "notificationThreshold")),
    // A form without the field keeps the default rather than clearing the tier.
    ...(data.has("adjacentTitles") ? { adjacentTitles: list(data, "adjacentTitles") } : {}),
  });
  if (!preferences.success) {
    const adjacent = preferences.error.issues[0]?.path[0] === "adjacentTitles";
    return { ok: false, field: adjacent ? "adjacentTitles" : "notificationThreshold" };
  }
  return { ok: true, matching: matching.data, preferences: preferences.data };
}
