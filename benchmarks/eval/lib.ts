import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { applyFilter, type FilterResult } from "../../src/filter";
import { normalizeListing } from "../../src/normalize";
import { MatchingProfileSchema } from "../../src/profile/schema";
import { SEED_MATCH_PROFILE } from "../../src/profile/seed";

const ExampleSchema = z.object({
  id: z.string(),
  split: z.enum(["tune", "heldout"]),
  language: z.enum(["en", "he", "mixed"]),
  kind: z.string(),
  title: z.string(),
  location: z.string(),
  description: z.string(),
  expected: z.object({ filter: z.enum(["eligible", "rejected"]), relevant: z.boolean(), role: z.string() }),
});

export type EvalExample = z.infer<typeof ExampleSchema>;

export function loadDataset(): EvalExample[] {
  const file = path.resolve(import.meta.dirname, "dataset.json");
  return z.object({ examples: z.array(ExampleSchema) }).parse(JSON.parse(readFileSync(file, "utf8"))).examples;
}

export const evalProfile = MatchingProfileSchema.parse(SEED_MATCH_PROFILE);

/** Passes a synthetic posting through the same normalizer and filter as a crawled one. */
export function filterExample(example: EvalExample): FilterResult {
  const listing = normalizeListing({
    providerJobId: example.id,
    requisitionId: null,
    title: example.title,
    originalDescription: example.description,
    descriptionText: example.description,
    location: example.location,
    extraLocations: [],
    workplaceType: null,
    commitment: null,
    salary: null,
    applicationUrl: `https://example.test/${example.id}`,
    publishedAt: null,
    providerUpdatedAt: null,
  });
  return applyFilter(listing, evalProfile);
}
