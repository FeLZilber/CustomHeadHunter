import { createHash } from "node:crypto";
import type { RawListing } from "../connectors/types";
import {
  detectEmploymentType,
  detectSeniority,
  detectWorkArrangement,
  extractExperience,
  extractTechnologies,
  type EmploymentType,
  type ExperienceRequirement,
  type Seniority,
  type TechnologyMention,
  type WorkArrangement,
} from "./extract";
import { foldText, isInIsraelScope, normalizeLocation, type Place, type RemoteScope } from "./location";
import { canonicalizeUrl } from "./url";

export const NORMALIZATION_VERSION = "normalize-v1";

export interface NormalizedListing {
  providerJobId: string;
  requisitionId: string | null;
  title: string;
  originalDescription: string;
  descriptionText: string;
  originalLocation: string | null;
  locations: Place[];
  isRemote: boolean;
  remoteScope: RemoteScope | null;
  inIsraelScope: boolean;
  workArrangement: WorkArrangement | null;
  employmentType: EmploymentType | null;
  seniority: Seniority | null;
  technologies: TechnologyMention[];
  experience: ExperienceRequirement | null;
  salary: RawListing["salary"];
  applicationUrl: string;
  canonicalUrl: string;
  publishedAt: Date | null;
  providerUpdatedAt: Date | null;
  contentHash: string;
}

type MatchingInput = Pick<
  NormalizedListing,
  | "title"
  | "descriptionText"
  | "locations"
  | "workArrangement"
  | "remoteScope"
  | "employmentType"
  | "seniority"
  | "technologies"
  | "experience"
  | "salary"
>;

/**
 * The matching-relevant view of a listing. Timestamps and URLs are excluded on
 * purpose. Values are flattened because stored jsonb does not keep key order.
 */
export function matchingFields(listing: MatchingInput) {
  const { salary } = listing;
  return {
    title: foldText(listing.title),
    description: foldText(listing.descriptionText),
    locations: listing.locations.map((place) => `${place.city ?? ""}/${place.region}`).sort(),
    workArrangement: listing.workArrangement,
    remoteScope: listing.remoteScope,
    employmentType: listing.employmentType,
    seniority: listing.seniority,
    technologies: listing.technologies.map((tech) => `${tech.name}:${tech.level}`).sort(),
    experience: listing.experience ? `${listing.experience.minYears}:${listing.experience.level}` : null,
    salary: salary ? [salary.min, salary.max, salary.currency, salary.period, salary.basis] : null,
  };
}

export type MatchingFields = ReturnType<typeof matchingFields>;

export function hashMatchingFields(fields: MatchingFields): string {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

export function normalizeListing(raw: RawListing): NormalizedListing {
  const location = normalizeLocation([raw.location, ...raw.extraLocations]);
  const base: Omit<NormalizedListing, "contentHash"> = {
    providerJobId: raw.providerJobId,
    requisitionId: raw.requisitionId,
    title: raw.title.trim(),
    originalDescription: raw.originalDescription,
    descriptionText: raw.descriptionText,
    originalLocation: raw.location,
    locations: location.places,
    isRemote: location.isRemote,
    remoteScope: location.remoteScope,
    inIsraelScope: isInIsraelScope(location),
    workArrangement: detectWorkArrangement(raw.workplaceType, raw.descriptionText) ?? (location.isRemote ? "remote" : null),
    employmentType: detectEmploymentType(raw.commitment, raw.title, raw.descriptionText),
    seniority: detectSeniority(raw.title),
    technologies: extractTechnologies(raw.descriptionText),
    experience: extractExperience(raw.descriptionText),
    salary: raw.salary,
    applicationUrl: raw.applicationUrl,
    canonicalUrl: canonicalizeUrl(raw.applicationUrl),
    publishedAt: raw.publishedAt,
    providerUpdatedAt: raw.providerUpdatedAt,
  };
  return { ...base, contentHash: hashMatchingFields(matchingFields(base)) };
}

/** Field groups that differ between two matching views, used to judge significance. */
export function changedFields(before: MatchingFields, after: MatchingFields): string[] {
  const groups: Record<string, Array<keyof MatchingFields>> = {
    title: ["title"],
    description: ["description"],
    locations: ["locations"],
    workArrangement: ["workArrangement", "remoteScope"],
    employmentType: ["employmentType"],
    seniority: ["seniority"],
    technologies: ["technologies"],
    experience: ["experience"],
    salary: ["salary"],
  };
  return Object.entries(groups)
    .filter(([, keys]) => keys.some((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])))
    .map(([group]) => group);
}
