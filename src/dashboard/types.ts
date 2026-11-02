import type { ModelOutput } from "../match/schema";

export interface MatchDetail {
  response: ModelOutput;
  /** Quotes that do not appear in the posting. The model is not a reliable quoter, so these are labelled. */
  unverified: string[];
  inputTruncated: boolean;
  evidenceTotal: number;
  evidenceLiteral: number;
  model: string;
  promptVersion: string;
  matchedAt: Date;
}
