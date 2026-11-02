import { foldText } from "./location";

export type RequirementLevel = "required" | "preferred" | "unspecified";

export interface TechnologyMention {
  name: string;
  level: RequirementLevel;
  evidence: string;
}

export interface ExperienceRequirement {
  minYears: number;
  level: RequirementLevel;
  evidence: string;
}

export type WorkArrangement = "remote" | "hybrid" | "onsite";
export type Seniority = "junior" | "mid" | "senior" | "lead" | "principal" | "manager";
export type EmploymentType = "full_time" | "part_time" | "contract" | "temporary" | "internship";

const TECHNOLOGIES: Array<[string, RegExp]> = [
  // Java must not match inside JavaScript, and node.js is not a Java mention.
  ["JavaScript", /(?<![\p{L}\d.])(?:javascript|java script|js|ecmascript)(?![\p{L}\d])/iu],
  ["TypeScript", /(?<![\p{L}\d])(?:typescript|type script|ts)(?![\p{L}\d])/iu],
  ["Java", /(?<![\p{L}\d.])java(?![\p{L}\d]|\s*script)/iu],
  ["Python", /(?<![\p{L}\d])python(?![\p{L}\d])/iu],
  ["C#", /(?<![\p{L}\d])c#(?![\p{L}\d])/iu],
  [".NET", /(?<![\p{L}\d])\.net(?![\p{L}\d])/iu],
  ["C++", /(?<![\p{L}\d])c\+\+/iu],
  ["Go", /(?<![\p{L}\d])(?:golang)(?![\p{L}\d])/iu],
  ["Node.js", /(?<![\p{L}\d])node(?:\.?js)?(?![\p{L}\d])/iu],
  ["React", /(?<![\p{L}\d])react(?:\.?js)?(?![\p{L}\d])/iu],
  ["Playwright", /(?<![\p{L}\d])playwright(?![\p{L}\d])/iu],
  ["Cypress", /(?<![\p{L}\d])cypress(?![\p{L}\d])/iu],
  ["Selenium", /(?<![\p{L}\d])selenium(?![\p{L}\d])/iu],
  ["Appium", /(?<![\p{L}\d])appium(?![\p{L}\d])/iu],
  ["Postman", /(?<![\p{L}\d])postman(?![\p{L}\d])/iu],
  ["k6", /(?<![\p{L}\d])k6(?![\p{L}\d])/iu],
  ["JMeter", /(?<![\p{L}\d])jmeter(?![\p{L}\d])/iu],
  ["Jest", /(?<![\p{L}\d])jest(?![\p{L}\d])/iu],
  ["Mocha", /(?<![\p{L}\d])mocha(?![\p{L}\d])/iu],
  ["pytest", /(?<![\p{L}\d])pytest(?![\p{L}\d])/iu],
  ["REST API", /(?<![\p{L}\d])(?:rest(?:ful)?\s*apis?|api testing|[ובה]*בדיקות api)(?![\p{L}\d])/iu],
  ["SQL", /(?<![\p{L}\d])(?:sql|postgres(?:ql)?|mysql)(?![\p{L}\d])/iu],
  ["Docker", /(?<![\p{L}\d])docker(?![\p{L}\d])/iu],
  ["Kubernetes", /(?<![\p{L}\d])(?:kubernetes|k8s)(?![\p{L}\d])/iu],
  ["AWS", /(?<![\p{L}\d])aws(?![\p{L}\d])/iu],
  ["CI/CD", /(?<![\p{L}\d])(?:ci\s*\/\s*cd|jenkins|github actions|gitlab ci)(?![\p{L}\d])/iu],
];

const REQUIRED_HEADING = /^(?:requirements?|qualifications?|must[- ]haves?|what you(?:'|’)?ll (?:need|bring)|what we(?:'|’)?re looking for|who you are|you have|דרישות(?: התפקיד| המשרה)?|דרישות חובה|כישורים נדרשים)\s*:?$/iu;
const PREFERRED_HEADING = /^(?:nice[- ]to[- ]haves?|bonus(?: points)?|preferred(?: qualifications?)?|advantages?|an advantage|plus|יתרון|יתרונות)\s*:?$/iu;
const OTHER_HEADING = /^(?:about (?:us|the (?:role|team|company)|you)|responsibilities|what you(?:'|’)?ll do|benefits|perks|why join|תיאור(?: המשרה| התפקיד)?|תחומי אחריות|על החברה)\s*:?$/iu;

const PREFERRED_INLINE = /\b(?:nice to have|advantage|advantageous|preferred|a plus|bonus|desirable)\b|יתרון/iu;
const REQUIRED_INLINE = /\b(?:must have|required|mandatory|strong|proven)\b|חובה/iu;

/** Line-level negation scoped to the words directly preceding a mention. */
const NEGATION = /(?:\b(?:no|not|without|never|non)\b|ללא|בלי|אין צורך ב|אינה כוללת|לא נדרש)[^.;\n]{0,30}$/iu;

interface Line {
  text: string;
  section: RequirementLevel;
}

function classifyLines(text: string): Line[] {
  let section: RequirementLevel = "unspecified";
  const lines: Line[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^[-•*\s]+/, "").trim();
    if (!line) continue;
    if (REQUIRED_HEADING.test(line)) section = "required";
    else if (PREFERRED_HEADING.test(line)) section = "preferred";
    else if (OTHER_HEADING.test(line)) section = "unspecified";
    else lines.push({ text: line, section });
  }
  return lines;
}

function levelOf(line: Line): RequirementLevel {
  if (PREFERRED_INLINE.test(line.text)) return "preferred";
  if (REQUIRED_INLINE.test(line.text)) return "required";
  return line.section;
}

const LEVEL_RANK: Record<RequirementLevel, number> = { required: 2, preferred: 1, unspecified: 0 };

export function extractTechnologies(description: string): TechnologyMention[] {
  const found = new Map<string, TechnologyMention>();
  for (const line of classifyLines(description)) {
    for (const [name, pattern] of TECHNOLOGIES) {
      const match = pattern.exec(line.text);
      if (!match) continue;
      if (NEGATION.test(line.text.slice(0, match.index))) continue;
      const mention: TechnologyMention = { name, level: levelOf(line), evidence: line.text.slice(0, 200) };
      const existing = found.get(name);
      if (!existing || LEVEL_RANK[mention.level] > LEVEL_RANK[existing.level]) found.set(name, mention);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const HEBREW_YEAR_WORDS: Record<string, number> = { שנתיים: 2, שנה: 1 };

const YEARS_EN = /(\d{1,2})\s*(?:\+|plus)?\s*(?:[-–]\s*\d{1,2}\s*)?(?:\+\s*)?years?/i;
const YEARS_HE = /(\d{1,2})\s*\+?\s*(?:[-–]\s*\d{1,2}\s*)?(?:שנים|שנות)/;
const YEARS_HE_WORD = /(?<![\p{L}])(שנתיים)(?![\p{L}])/u;
const EXPERIENCE_CONTEXT = /experience|ניסיון|נסיון/i;

/** Returns the strongest stated experience requirement, or null when none is stated. */
export function extractExperience(description: string): ExperienceRequirement | null {
  let best: ExperienceRequirement | null = null;
  for (const line of classifyLines(description)) {
    if (!EXPERIENCE_CONTEXT.test(line.text)) continue;
    const match = YEARS_EN.exec(line.text) ?? YEARS_HE.exec(line.text) ?? YEARS_HE_WORD.exec(line.text);
    if (!match?.[1]) continue;
    const minYears = HEBREW_YEAR_WORDS[match[1]] ?? Number(match[1]);
    if (minYears > 40) continue;
    const level = levelOf(line);
    const candidate = { minYears, level, evidence: line.text.slice(0, 200) };
    if (!best || LEVEL_RANK[level] > LEVEL_RANK[best.level] || (level === best.level && minYears > best.minYears)) {
      best = candidate;
    }
  }
  return best;
}

export function detectSeniority(title: string): Seniority | null {
  const text = foldText(title);
  if (/(?<![\p{L}])(?:principal|staff|architect)(?![\p{L}])/u.test(text)) return "principal";
  if (/(?<![\p{L}])(?:head|director|vp|manager|מנהל|מנהלת)(?![\p{L}])/u.test(text)) return "manager";
  if (/(?<![\p{L}])(?:lead|tech lead|team lead|ראש צוות|מוביל|מובילה)(?![\p{L}])/u.test(text)) return "lead";
  if (/(?<![\p{L}])(?:senior|sr|בכיר|בכירה)(?![\p{L}])/u.test(text)) return "senior";
  if (/(?<![\p{L}])(?:junior|jr|entry level|graduate|intern|student|ג ?וניור|סטודנט)(?![\p{L}])/u.test(text)) return "junior";
  if (/(?<![\p{L}])(?:mid level|mid)(?![\p{L}])/u.test(text)) return "mid";
  return null;
}

export function detectWorkArrangement(provider: string | null | undefined, description: string): WorkArrangement | null {
  if (provider === "remote") return "remote";
  if (provider === "hybrid") return "hybrid";
  if (provider === "on-site") return "onsite";
  const text = foldText(description);
  if (/\bhybrid\b|היברידי/u.test(text)) return "hybrid";
  if (/\bfully remote\b|\bremote (?:position|role|job)\b|עבודה מרחוק מלאה/u.test(text)) return "remote";
  return null;
}

/**
 * Title and provider fields are trusted; the description needs an explicit phrase
 * because "contract testing" and "mentoring interns" are ordinary QA vocabulary.
 */
export function detectEmploymentType(
  provider: string | null | undefined,
  title: string,
  description: string,
): EmploymentType | null {
  const stated = foldText([provider, title].filter(Boolean).join(" "));
  const body = foldText(description);
  if (/\bintern(?:ship)?\b|\bstudent\b|סטודנט/u.test(stated) || /\binternship (?:program|position)\b|משרת סטודנט/u.test(body)) {
    return "internship";
  }
  if (/\btemporary\b|\bmaternity\b|מילוי מקום/u.test(stated) || /\btemporary position\b|\bmaternity cover\b/u.test(body)) {
    return "temporary";
  }
  if (/\bcontract(?:or)?\b|\bfreelance\b/u.test(stated) || /\bcontract (?:position|role|basis)\b/u.test(body)) return "contract";
  if (/\bpart time\b|משרה חלקית/u.test(stated) || /\bpart time (?:position|role|job)\b|משרה חלקית/u.test(body)) return "part_time";
  if (/\bfull time\b|\bregular\b|\bpermanent\b|משרה מלאה/u.test(stated) || /\bfull time (?:position|role|job)\b|משרה מלאה/u.test(body)) {
    return "full_time";
  }
  return null;
}
