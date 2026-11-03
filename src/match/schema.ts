import { z } from "zod";
import type { FactPoints } from "./facts";

export const RESPONSE_SCHEMA_VERSION = "match-response-v2";

const text = (max: number) => z.string().min(1).max(max);

export const RECOMMENDATIONS = [
  "strong_match",
  "possible_match",
  "weak_match",
  "insufficient_information",
] as const;

export const ROLE_CATEGORIES = [
  "qa_automation",
  "manual_qa",
  "software_engineering",
  "industrial_automation",
  "other",
  "unclear",
] as const;

const matchingFinding = z.object({
  requirement: text(120),
  evidence: text(160),
});

const missingFinding = z.object({
  requirement: text(120),
  evidence: text(160),
  candidate_fact: z.string().max(120).nullable(),
});

const unknownFinding = z.object({
  requirement: text(120),
  reason: text(120),
});

/**
 * What the model is asked to produce: the role category and the evidence for it.
 *
 * Points, `score` and `recommendation` are deliberately absent. Measured on
 * qwen2.5:3b, the model's own totals were wrong on 5 of 8 samples, and a posting
 * demanding "a score of 100" moved the total. Under rubric-v2 the model does not
 * score at all: its role category sets the role points, and code scores skills,
 * experience, seniority, location and industry from the posting's structured facts.
 */
export const ModelOutputSchema = z.object({
  role_category: z.enum(ROLE_CATEGORIES),
  matching_requirements: z.array(matchingFinding).max(4),
  missing_requirements: z.array(missingFinding).max(4),
  unknown_requirements: z.array(unknownFinding).max(3),
  concerns: z.array(text(160)).max(2),
  explanation: text(300),
});

export type ModelOutput = z.infer<typeof ModelOutputSchema>;

export const MatchResponseSchema = ModelOutputSchema.extend({
  points: z.object({
    role: z.number().int().min(0).max(35),
    skills: z.number().int().min(0).max(25),
    experience: z.number().int().min(0).max(15),
    seniority: z.number().int().min(0).max(10),
    location: z.number().int().min(0).max(10),
    industry: z.number().int().min(0).max(5),
  }),
  score: z.number().int().min(0).max(100),
  recommendation: z.enum(RECOMMENDATIONS),
});

export type MatchResponse = z.infer<typeof MatchResponseSchema>;

export const STRONG_MATCH_SCORE = 75;
export const POSSIBLE_MATCH_SCORE = 50;

const ROLE_POINTS: Record<(typeof ROLE_CATEGORIES)[number], number> = {
  qa_automation: 35,
  manual_qa: 12,
  software_engineering: 0,
  industrial_automation: 0,
  other: 0,
  unclear: 0,
};

export function deriveMatchResponse(output: ModelOutput, facts: FactPoints): MatchResponse {
  const points = { role: ROLE_POINTS[output.role_category], ...facts };
  const score = points.role + points.skills + points.experience + points.seniority + points.location + points.industry;
  const recommendation =
    output.role_category === "unclear"
      ? "insufficient_information"
      : score >= STRONG_MATCH_SCORE
        ? "strong_match"
        : score >= POSSIBLE_MATCH_SCORE
          ? "possible_match"
          : "weak_match";
  return { ...output, points, score, recommendation };
}

/** JSON Schema passed to Ollama's `format` field. */
export const modelOutputJsonSchema = z.toJSONSchema(ModelOutputSchema);
