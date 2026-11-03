import { withTransaction, type Pool } from "../db/pool";
import type { HttpClient } from "../http/client";
import { careerUrl } from "./board-url";
import { probeBoard, verificationUrl, type ProbeResult } from "./probe";

export interface AdoptSummary {
  added: number;
  rejected: number;
  retry: number;
}

type Probe = (http: HttpClient, provider: ProbeResult["provider"], key: string) => Promise<ProbeResult>;

/**
 * Turns the owner's pending requests into sources. The catalog's bar applies: the board must
 * answer and hold at least one Israeli job. A network error leaves the request pending so
 * the next run tries again; it never fails the pipeline.
 */
export async function adoptRequestedSources(pool: Pool, http: HttpClient, probe: Probe = probeBoard): Promise<AdoptSummary> {
  const summary: AdoptSummary = { added: 0, rejected: 0, retry: 0 };
  const { rows } = await pool.query(
    `SELECT id, provider, provider_key, company_name FROM requested_sources WHERE status = 'pending' ORDER BY id LIMIT 20`,
  );
  for (const row of rows) {
    const result = await probe(http, row.provider, row.provider_key).catch(() => null);
    if (!result || result.status === "error") {
      summary.retry += 1;
      continue;
    }
    if (result.status === "missing" || result.israeli === 0) {
      const detail = result.status === "missing" ? "No public board with this key" : `Board found, but it lists no Israeli jobs (${result.total} total)`;
      await pool.query(`UPDATE requested_sources SET status = 'rejected', detail = $2, decided_at = now() WHERE id = $1`, [row.id, detail]);
      summary.rejected += 1;
      continue;
    }
    await withTransaction(pool, async (client) => {
      const company = await client.query(
        `INSERT INTO companies (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [row.company_name],
      );
      await client.query(
        `INSERT INTO job_sources (company_id, provider, provider_key, career_url, country_coverage, enabled,
                                  verified_at, verification_source_url, origin)
         VALUES ($1, $2, $3, $4, ARRAY['IL'], true, now(), $5, 'requested')
         ON CONFLICT (provider, provider_key) DO NOTHING`,
        [company.rows[0].id, row.provider, row.provider_key, careerUrl({ provider: row.provider, providerKey: row.provider_key }),
         verificationUrl(row.provider, row.provider_key)],
      );
      await client.query(
        `UPDATE requested_sources SET status = 'added', detail = $2, decided_at = now() WHERE id = $1`,
        [row.id, `${result.israeli} Israeli jobs of ${result.total}`],
      );
    });
    summary.added += 1;
  }
  return summary;
}
