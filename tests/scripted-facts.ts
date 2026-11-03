import type { FactPoints } from "../src/match/facts";

/**
 * Tests steer a job's score with the `skills` number in the fake model's reply. Production code
 * scores skills from the posting's facts, so tests pin the fact scorer: the fake model reports each
 * reply here and the pinned scorer returns it. Role is 35 and the other pinned points total 20, so
 * a reply with `skills: 25` scores 80, as it did before the model stopped scoring.
 */
export function scriptedFacts() {
  let skills = 25;
  return {
    observe(content: string) {
      try {
        const parsed = JSON.parse(content) as { points?: { skills?: unknown } };
        if (typeof parsed.points?.skills === "number") skills = parsed.points.skills;
      } catch {
        // A reply that is not JSON never reaches scoring.
      }
    },
    scoreFacts: (): FactPoints => ({ skills, experience: 8, seniority: 5, location: 5, industry: 2 }),
  };
}
