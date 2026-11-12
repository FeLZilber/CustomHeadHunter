import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { withTransaction, type Pool } from "../db/pool";

const CatalogSchema = z.object({
  sources: z.array(
    z.object({
      company: z.string().min(1),
      industry: z.string().min(1),
      provider: z.enum(["greenhouse", "lever", "ashby", "workable", "jsonld", "workday"]),
      providerKey: z.string().min(1),
      careerUrl: z.string().url(),
      countryCoverage: z.array(z.string().min(2)).min(1),
      enabled: z.boolean(),
      verifiedAt: z.iso.datetime(),
      verificationSourceUrl: z.string().url(),
    }),
  ),
});

export const CATALOG_PATH = path.resolve(import.meta.dirname, "../../catalog/sources.json");

/** The catalog file is authoritative for catalog sources: one removed from it is disabled, not deleted. Requested sources are left alone. */
export async function seedCatalog(pool: Pool, file = CATALOG_PATH): Promise<{ sources: number; disabled: number }> {
  const { sources } = CatalogSchema.parse(JSON.parse(await readFile(file, "utf8")));
  return withTransaction(pool, async (client) => {
    for (const source of sources) {
      const { rows } = await client.query(
        `INSERT INTO companies (name, industry) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET industry = EXCLUDED.industry
         RETURNING id`,
        [source.company, source.industry],
      );
      await client.query(
        `INSERT INTO job_sources (company_id, provider, provider_key, career_url, country_coverage, enabled,
                                  verified_at, verification_source_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (provider, provider_key) DO UPDATE SET
           company_id = EXCLUDED.company_id, career_url = EXCLUDED.career_url,
           country_coverage = EXCLUDED.country_coverage, enabled = EXCLUDED.enabled,
           verified_at = EXCLUDED.verified_at, verification_source_url = EXCLUDED.verification_source_url`,
        [
          rows[0].id,
          source.provider,
          source.providerKey,
          source.careerUrl,
          source.countryCoverage,
          source.enabled,
          source.verifiedAt,
          source.verificationSourceUrl,
        ],
      );
    }
    const keys = sources.map((source) => `${source.provider}:${source.providerKey}`);
    const { rowCount } = await client.query(
      `UPDATE job_sources SET enabled = false WHERE enabled AND origin = 'catalog' AND NOT (provider || ':' || provider_key = ANY($1))`,
      [keys],
    );
    return { sources: sources.length, disabled: rowCount ?? 0 };
  });
}
