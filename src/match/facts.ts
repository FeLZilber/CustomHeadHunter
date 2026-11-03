import type { ExperienceRequirement, Seniority, TechnologyMention } from "../normalize/extract";
import { foldText, type Place, type RemoteScope } from "../normalize/location";
import type { MatchProfile } from "./prompt";

/**
 * Structured facts the pipeline already extracted from a posting. Code scores these exactly:
 * a 3B model counts skills and compares years unreliably, and the same input scored 85 on
 * one runner and 78 on another. The model keeps what needs language: the role category and
 * the evidence for it.
 */
export interface JobFacts {
  seniority: Seniority | null;
  experience: ExperienceRequirement | null;
  technologies: TechnologyMention[];
  locations: Place[];
  remoteScope: RemoteScope | null;
  /** The company's industry from the catalog. */
  industry: string | null;
}

export interface FactPoints {
  skills: number;
  experience: number;
  seniority: number;
  location: number;
  industry: number;
}

/** Maximum points per criterion under rubric-v2. Role is scored from the model's category. */
export const RUBRIC_MAX = { role: 35, skills: 25, experience: 15, seniority: 10, location: 10, industry: 5 } as const;

/** Neutral points when the posting says nothing, so missing facts neither reward nor punish. */
export const UNKNOWN = { skills: 13, experience: 8, seniority: 6, location: 5, industry: 2 } as const satisfies FactPoints;

const fold = (value: string) => ` ${foldText(value)} `;
const same = (a: string, b: string) => {
  const left = fold(a);
  const right = fold(b);
  return left === right || (foldText(a).length >= 3 && foldText(b).length >= 3 && (left.includes(right) || right.includes(left)));
};

const RANK: Record<Exclude<Seniority, "manager">, number> = { junior: 0, mid: 1, senior: 2, lead: 3, principal: 3 };

/** Profile seniorities are free text such as "Staff"; staff and architect are principal-level in the job data. */
function profileRanks(seniorities: string[] | undefined): number[] {
  const ranks: number[] = [];
  for (const raw of seniorities ?? []) {
    const text = foldText(raw);
    if (/(?:^| )(?:staff|principal|architect)(?: |$)/.test(text)) ranks.push(RANK.principal);
    else if (/(?:^| )lead(?: |$)/.test(text)) ranks.push(RANK.lead);
    else if (/(?:^| )senior(?: |$)/.test(text)) ranks.push(RANK.senior);
    else if (/(?:^| )mid(?: |$)/.test(text)) ranks.push(RANK.mid);
    else if (/(?:^| )junior(?: |$)/.test(text)) ranks.push(RANK.junior);
  }
  return ranks;
}

export function scoreExperience(profile: MatchProfile, experience: ExperienceRequirement | null): number {
  const candidate = profile.candidateExperienceYears;
  if (!candidate || !experience || experience.level !== "required") return UNKNOWN.experience;
  const gap = experience.minYears - candidate.max;
  if (gap <= 0) return 15;
  if (gap <= 2) return 10;
  if (gap <= 5) return 4;
  return 0;
}

export function scoreSeniority(profile: MatchProfile, seniority: Seniority | null): number {
  const ranks = profileRanks(profile.seniorities);
  if (ranks.length === 0 || seniority === null) return UNKNOWN.seniority;
  if (seniority === "manager") return 2;
  const rank = RANK[seniority];
  if (ranks.includes(rank)) return 10;
  if (rank > Math.max(...ranks)) return 7;
  return Math.min(...ranks) - rank === 1 ? 4 : 0;
}

export function scoreLocation(profile: MatchProfile, places: Place[], remoteScope: RemoteScope | null): number {
  const preferred = profile.preferredLocations;
  if (places.some((place) => place.city && preferred.some((p) => same(p, place.city!)))) return 10;
  if (places.some((place) => preferred.some((p) => same(p, place.region)))) return 8;
  if (places.length > 0) return 4;
  if (remoteScope === "israel" || remoteScope === "worldwide" || remoteScope === "unstated") return 7;
  return UNKNOWN.location;
}

export function scoreSkills(profile: MatchProfile, technologies: TechnologyMention[]): number {
  if (technologies.length === 0) return UNKNOWN.skills;
  const have = [...profile.requiredSkills, ...profile.preferredSkills];
  let total = 0;
  let matched = 0;
  for (const technology of technologies) {
    const weight = technology.level === "required" ? 2 : 1;
    total += weight;
    if (have.some((skill) => same(skill, technology.name))) matched += weight;
  }
  return Math.round((RUBRIC_MAX.skills * matched) / total);
}

export function scoreIndustry(profile: MatchProfile, industry: string | null): number {
  if (!industry) return UNKNOWN.industry;
  return profile.preferredIndustries.some((preferred) => same(preferred, industry)) ? 5 : UNKNOWN.industry;
}

export function scoreFacts(profile: MatchProfile, facts: JobFacts): FactPoints {
  return {
    skills: scoreSkills(profile, facts.technologies),
    experience: scoreExperience(profile, facts.experience),
    seniority: scoreSeniority(profile, facts.seniority),
    location: scoreLocation(profile, facts.locations, facts.remoteScope),
    industry: scoreIndustry(profile, facts.industry),
  };
}
