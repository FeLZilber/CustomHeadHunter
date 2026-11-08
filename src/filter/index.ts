import { foldText, type Place, type RemoteScope } from "../normalize/location";
import type { EmploymentType, ExperienceRequirement, Seniority, TechnologyMention } from "../normalize/extract";
import type { MatchingProfile } from "../profile/schema";
import { scoreExperience, scoreLocation, scoreSeniority, scoreSkills } from "../match/facts";

export const FILTER_VERSION = "filter-v4";

export interface FilterJob {
  title: string;
  descriptionText: string;
  seniority: Seniority | null;
  employmentType: EmploymentType | null;
  technologies: TechnologyMention[];
  experience: ExperienceRequirement | null;
  locations: Place[];
  remoteScope: RemoteScope | null;
}

export interface FilterResult {
  decision: "eligible" | "rejected";
  reasons: string[];
  /** Spends a limited inference budget on the likeliest jobs first. */
  priority: number;
}

const word = (pattern: string) => new RegExp(`(?<![\\p{L}\\d])(?:${pattern})(?![\\p{L}\\d])`, "u");

// Text is folded first: lower case, punctuation becomes spaces.
const QA_TITLE = word(
  "qa|qe|sdet|sdets|quality assurance|quality engineer|quality engineering|test automation|automation test(?:er|ing)?|" +
    "test engineer|test development|test developer|software tester|tester|software engineer in test|" +
    "developer in test|developers in test|[ובהל]?בדיקות|בודק|בודקת|בודקי|בודקות",
);
const AMBIGUOUS_TITLE = word(
  "automation|automations|quality|test|testing|validation|verification|e2e|end to end|developer productivity|" +
    "engineering productivity|[ובהל]?אוטומציה|[ובהל]?איכות",
);
const OTHER_DISCIPLINE_TITLE = word(
  "sales|account executive|account manager|business development|bdr|sdr|marketing|growth marketer|brand|content|" +
    "finance|financial analyst|accountant|accounting|controller|bookkeeper|legal|counsel|paralegal|" +
    "recruiter|recruiting|talent|human resources|hr|people partner|office manager|procurement|" +
    "customer success|customer support|support specialist|ad operation|ad operations|mechanical|" +
    "graphic designer|ux designer|ui designer|product designer|product marketing|מכירות|שיווק|חשב|חשבת|משאבי אנוש|גיוס",
);
// These engineers mention test tools as part of their own stack. A plain "Software Engineer" is left out: it can hide an SDET role.
const OTHER_ENGINEERING_TITLE = word(
  "devops|site reliability|sre|backend|back end|frontend|front end|full stack|fullstack|data engineer|bi engineer|" +
    "bi developer|security researcher|platform engineer|platform engineering",
);
const SOFTWARE_TEST_SIGNAL = word(
  "test automation|automated test|automated tests|automated testing|automation framework|automation frameworks|" +
    "playwright|cypress|selenium|webdriver|appium|sdet|qa automation|qa engineer|qa engineers|e2e tests|" +
    "end to end tests|בדיקות אוטומטיות|אוטומציה לבדיקות",
);
const INDUSTRIAL_SIGNAL = word(
  "plc|plcs|scada|hmi|siemens|allen bradley|robotic cell|robotic cells|factory floor|production line|production lines|" +
    "mechatronics|בקרים|מכטרוניקה|קו ייצור",
);

/** One title tier outranks any amount of fact fit: facts add at most 60 points. */
const TIER = 100;

/**
 * Orders jobs inside a title tier by how well their stated facts fit the profile, so the
 * limited model budget goes to the likeliest jobs. Unknown facts score neutral, never zero.
 */
function factFit(job: FilterJob, profile: MatchingProfile): number {
  return (
    scoreSkills(profile, job.technologies) +
    scoreExperience(profile, job.experience) +
    scoreSeniority(profile, job.seniority) +
    scoreLocation(profile, job.locations, job.remoteScope)
  );
}

/** A posting this short says too little to reject on content. */
const MIN_DESCRIBED_CHARS = 200;

export const includesTerm = (text: string, term: string) => word(foldText(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(text);

function classifyTitle(title: string, description: string, profile: MatchingProfile) {
  const hasSignal = SOFTWARE_TEST_SIGNAL.test(description);
  const isIndustrial = INDUSTRIAL_SIGNAL.test(description);
  if (QA_TITLE.test(title)) return { reject: null, reason: "title_relevant", priority: 3 };
  if (OTHER_DISCIPLINE_TITLE.test(title)) return { reject: "title_other_discipline", reason: "", priority: 0 };
  // "Automation Engineer" alone cannot separate software QA from factory controls.
  const named = profile.titles.some((target) => includesTerm(title, target));
  if (named || AMBIGUOUS_TITLE.test(title)) {
    if (isIndustrial && !hasSignal) return { reject: "industrial_automation", reason: "", priority: 0 };
    return { reject: null, reason: "title_ambiguous", priority: hasSignal ? 2 : 1 };
  }
  if (hasSignal) {
    if (OTHER_ENGINEERING_TITLE.test(title)) return { reject: "title_other_engineering", reason: "", priority: 0 };
    return { reject: null, reason: "description_mentions_test_automation", priority: 0 };
  }
  if (description.length < MIN_DESCRIBED_CHARS) return { reject: null, reason: "description_too_short", priority: 0 };
  return { reject: "no_qa_signal", reason: "", priority: 0 };
}

/**
 * Rejects only clear violations of a hard rule; anything uncertain stays
 * eligible for the model. Missing facts never reject: each rule first requires
 * the fact to be stated. Experience needs a `required` level because company
 * history ("20 years of experience") is extracted as `unspecified`.
 */
export function applyFilter(job: FilterJob, profile: MatchingProfile): FilterResult {
  const title = foldText(job.title);
  const description = foldText(job.descriptionText);
  const rules = profile.hardRules;
  const rejected: string[] = [];

  if (!job.locations.some((place) => place.country === "IL") && job.remoteScope === "other_country") {
    rejected.push("location_outside_israel");
  }
  if (rules.excludedTitleTerms.some((term) => includesTerm(title, term))) rejected.push("excluded_title_term");
  if (job.employmentType && rules.excludedEmploymentTypes.includes(job.employmentType)) {
    rejected.push("excluded_employment_type");
  }
  if (job.seniority && rules.excludedSeniorities.includes(job.seniority)) rejected.push("excluded_seniority");

  const excludedTechnologies = rules.excludedRequiredTechnologies.map(foldText);
  if (job.technologies.some((tech) => tech.level === "required" && excludedTechnologies.includes(foldText(tech.name)))) {
    rejected.push("excluded_required_technology");
  }

  const candidate = profile.candidateExperienceYears;
  const required = job.experience?.level === "required" ? job.experience.minYears : null;
  if (candidate && required !== null && required > candidate.max + rules.maxExperienceGapYears) {
    rejected.push("experience_far_above_candidate");
  }

  const classified = classifyTitle(title, description, profile);
  if (classified.reject) rejected.push(classified.reject);
  if (rejected.length > 0) return { decision: "rejected", reasons: rejected, priority: 0 };

  const reasons = [classified.reason];
  if (job.experience === null) reasons.push("experience_unknown");
  if (job.technologies.length === 0) reasons.push("technologies_unknown");
  return { decision: "eligible", reasons, priority: classified.priority * TIER + factFit(job, profile) };
}
