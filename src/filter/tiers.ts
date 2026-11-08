import { foldText } from "../normalize/location";
import { includesTerm } from "./index";

export type Tier = "strict" | "adjacent";

/** Rejections that only say "this is a different role". Every other reason is a hard rule and stays final. */
export const TITLE_ONLY_REJECTIONS: readonly string[] = [
  "no_qa_signal",
  "title_other_discipline",
  "title_other_engineering",
  "industrial_automation",
];

/**
 * Computed at display time, never stored: the strict tier is the filter's own verdict, and the
 * adjacent tier is a rejected job whose only fault is the role and whose title names a nearby one.
 */
export function classifyTier(
  e: { decision: "eligible" | "rejected"; reasons: string[]; title: string },
  adjacentTitles: string[],
): Tier | null {
  if (e.decision === "eligible") return "strict";
  if (e.reasons.length === 0 || !e.reasons.every((reason) => TITLE_ONLY_REJECTIONS.includes(reason))) return null;
  const title = foldText(e.title);
  return adjacentTitles.some((term) => foldText(term) !== "" && includesTerm(title, term)) ? "adjacent" : null;
}
