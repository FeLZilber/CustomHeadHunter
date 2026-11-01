# Project status

Resume document. Update after every milestone and any decision a new session could not re-derive.

- **Plan:** `Personal_Job_Hunter_Claude_Prompt.txt` in the repo root (gitignored, operator's local brief). Sections 18 (tests) and 21 (final report) define done.
- **Branch:** `mvp`, pushed. Default branch is `master`. Scheduled and dispatch workflows only operate once they reach `master`.
- **Last updated:** 2026-11-01

## Milestones

| Milestone | State |
| --- | --- |
| M0 Feasibility | Local benchmark done. Hosted run in progress on Actions (workflow `ollama-feasibility`). |
| M1 Durable ingestion | Done, committed. Live-tested locally against real boards. Not deployed. |
| M2 Bounded AI | Not started. Prompt, schema and Ollama client from M0 are reusable. |
| M3 Notifications and automation | Not started. |
| M4 Private dashboard and dev setup | Not started. |
| M5 MVP hardening and handover | Not started. |

## M0 results so far

Local only, Apple M2 Pro with GPU. **Not evidence for hosted performance.** 8 synthetic samples, 3 passes: 23/23 warm attempts valid, median 5.5 s, max 7.5 s, median prompt 517 tokens, median output 299 tokens, 55/66 evidence quotes literal. Budget defaults in `src/config/budget.ts` are provisional until the hosted run reports.

After the hosted run: `gh run download`, take cache timings from `gh run view --json jobs`, store a curated result in `benchmarks/results/`, delete the spike cache, set budget defaults, write `COSTS.md` and `OLLAMA_SETUP.md`.

## M1 results

Run with `npm run check:live-ingest` (2026-11-01): seeds `catalog/sources.json` into a throwaway embedded Postgres, then crawls twice. It reads public boards only.

| Run | Duration | Snapshots | Canonical jobs | Listings | Events | Duplicate keys |
| --- | --- | --- | --- | --- | --- | --- |
| First | 22 s | 21 complete | 272 | 272 | 272 | 0 |
| Second | 7 s | 21 `not_modified` | 272 | 272 | 272 | 0 |

Tests: 186 passing against embedded Postgres, `tsc` clean.

**Finding, target-role recall is low.** A one-off audit of the same boards found 1,776 raw postings, 272 in Israeli scope, and no posting with an Israeli location rejected by the scope filter. Only 3 in-scope titles look QA-related, and only one is plausibly a QA role (Cato "Automation Engineer"). This is catalog coverage, not a filter bug: these boards list few Israeli QA jobs. Do not pad the catalog with unverified sources. Report this in the final report as the main product risk. New ATS connectors are roadmap work and need separate authorization.

## Decisions a new session should keep

- **Model judges, code does arithmetic.** `score` and `recommendation` are derived from per-criterion `points`. This deviates from passing the full contract to the model and must be documented in `ARCHITECTURE.md`.
- **Database:** Neon Free. Supabase Free rejected (pauses after a week, 500 MB).
- **Tests:** vitest global setup uses `TEST_DATABASE_URL` when set, otherwise `embedded-postgres`, because this machine has no Docker and no Postgres.
- **Locks:** transaction-scoped advisory locks only (safe with Neon pooling), plus leases for crawl claims.
- **Lever ETags:** stored only when a complete snapshot fit in one page, because a 304 proves a whole board unchanged only then.
- **Catalog gap:** few Lever sources and few banks or government employers on these ATSs. Document it; do not invent endpoints.
- **Freshness:** absence counts only on complete reconciles; a 304 counts as a repeated complete snapshot; suspicious snapshots do not advance the checkpoint; after `grace` consecutive suspicious snapshots the next is believed. The suspicion check counts newly absent listings only, or a confirmed closure would stall.

## Things not to forget

- `gh` billing usage is unreadable without the `user` scope, so actual Actions spend is unknown. Two `gh` accounts are logged in; `FeLZilber` is active.
- A hosted spike costs about 35 runner minutes.
- Docker is absent locally, so `docker-compose` cannot be exercised here unless installed. Record that as not live-tested.
- No Actions secrets, Neon project, Telegram bot, OAuth app or Vercel project exist. Operator steps go in `DEPLOYMENT.md`; do not claim any of them happened.
