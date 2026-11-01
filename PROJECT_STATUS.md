# Project status

Resume document. Update after every milestone and any decision a new session could not re-derive.

- **Plan:** `Personal_Job_Hunter_Claude_Prompt.txt` in the repo root (gitignored, operator's local brief). Sections 18 (tests) and 21 (final report) define done.
- **Branch:** `mvp`, pushed. Default branch is `master`. Scheduled and dispatch workflows only operate once they reach `master`.
- **Last updated:** 2026-11-01

## Milestones

| Milestone | State |
| --- | --- |
| M0 Feasibility | Hosted run succeeded (run 41307706600). Limits changed from it; rerun with the new limits pending. `COSTS.md` and `OLLAMA_SETUP.md` not yet written. |
| M1 Durable ingestion | Done, committed. Live-tested locally against real boards. Not deployed. |
| M2 Bounded AI | Done, committed. Live-tested locally (GPU) on real postings. Not run on Actions yet; not deployed. |
| M3 Notifications and automation | Not started. |
| M4 Private dashboard and dev setup | Not started. |
| M5 MVP hardening and handover | Not started. |

## M0 results

Hosted, 2026-11-01, `ubuntu-24.04`, 2 vCPU, CPU only. Curated data: `benchmarks/results/hosted-ubuntu-24.04-2026-11-01.json`.

| Measure | Cache miss | Cache hit |
| --- | --- | --- |
| Job duration | 10.2 min (1 pass) | 18.0 min (2 passes) |
| Ollama start | 82 s | 72 s |
| Warm attempts, ok of total | 6 of 7 | 12 of 15 |
| Median / max inference | 53.7 / 92.1 s | 54.6 / 90.0 s |
| Peak container memory | 2392 MiB | 2415 MiB |

Output runs at 6.3 tokens/s. 4 of 24 attempts were cut off at `num_predict` 500, all Hebrew. `he-qa-automation-bank` never completed. No timeouts, and no invalid JSON apart from those cut-offs. The local GPU run did not show this.

Limits after that run: output 800, timeout 180 s, input 1600, 8 jobs per run, 600 s AI budget.

**Pending:** push run of `ollama-feasibility` with those limits, then delete its `-spike-` cache, add the result to `benchmarks/results/`, write `COSTS.md` and `OLLAMA_SETUP.md`.

## M1 results

Run with `npm run check:live-ingest` (2026-11-01): seeds `catalog/sources.json` into a throwaway embedded Postgres, then crawls twice. It reads public boards only.

| Run | Duration | Snapshots | Canonical jobs | Listings | Events | Duplicate keys |
| --- | --- | --- | --- | --- | --- | --- |
| First | 22 s | 21 complete | 272 | 272 | 272 | 0 |
| Second | 7 s | 21 `not_modified` | 272 | 272 | 272 | 0 |

Tests: 186 passing against embedded Postgres, `tsc` clean.

**Finding, target-role recall is low.** A one-off audit of the same boards found 1,776 raw postings, 272 in Israeli scope, and no posting with an Israeli location rejected by the scope filter. Only 3 in-scope titles look QA-related, and only one is plausibly a QA role (Cato "Automation Engineer"). This is catalog coverage, not a filter bug: these boards list few Israeli QA jobs. Do not pad the catalog with unverified sources. Report this in the final report as the main product risk. New ATS connectors are roadmap work and need separate authorization.

## M2 results

`LIVE_MATCH_JOBS=8 AI_TIME_BUDGET_SECONDS=800 npm run check:live-ingest` (2026-11-01), local GPU, real boards: 272 active jobs, filter rejected 261, 11 eligible, a second `evaluate` did nothing, 8 scored with 0 failures, 0 validation retries, 4 truncated inputs. Cato "Automation Engineer" scored 85, strong match. One job took 176 s on a GPU, cause unknown, just under the 180 s timeout.

That run used the prompt before `software_engineering` and `other` were defined; it labelled ordinary DevOps jobs `unclear`. Eval below is after the wording fix.

`benchmarks/eval` (20 synthetic examples, **labels machine-proposed, no human review**), local GPU, results in `benchmarks/results/eval-local-2026-11-01.json`:

| Split | Filter agreement | Relevant rejected by filter | Scored | Failures | Role agreement | Alerts on relevant / alerts | Relevant alerted |
| --- | --- | --- | --- | --- | --- | --- | --- |
| tune | 10/10 | 0 | 6 | 0 | 5/6 | 4/4 | 4/4 |
| heldout | 10/10 | 0 | 6 | 0 | 6/6 | 3/3 | 3/3 |

These measure agreement with a draft, not quality. Human calibration is outstanding. Literal evidence is weak, especially in Hebrew (0/4 on `t02`), so evidence is stored as verified or not and must be shown that way.

## Decisions a new session should keep

- **Model judges, code does arithmetic.** `score` and `recommendation` are derived from per-criterion `points`. This deviates from passing the full contract to the model and must be documented in `ARCHITECTURE.md`.
- **Database:** Neon Free. Supabase Free rejected (pauses after a week, 500 MB).
- **Tests:** vitest global setup uses `TEST_DATABASE_URL` when set, otherwise `embedded-postgres`, because this machine has no Docker and no Postgres.
- **Locks:** transaction-scoped advisory locks only (safe with Neon pooling), plus leases for crawl claims.
- **Lever ETags:** stored only when a complete snapshot fit in one page, because a 304 proves a whole board unchanged only then.
- **Input key:** content hash, profile matching hash, match config hash (model digest, prompt, schema, rubric, inference options, input limit). The filter version is excluded on purpose: a filter release re-evaluates and reuses answers.
- **Ollama errors:** `unavailable` releases the claim with no attempt spent and stops the stage. `http` spends an attempt and stops, so one bad job cannot block the queue for ever. `timeout` spends an attempt and continues.
- **Truncation:** keeps the opening and the requirements section, because a head-only cut lost requirements on most long real postings.
- **Claiming:** a task is runnable only while its key is the job's current key and its profile hash is current, so stale work is never started even before `evaluate` reruns.
- **Catalog gap:** few Lever sources and few banks or government employers on these ATSs. Document it; do not invent endpoints.
- **Freshness:** absence counts only on complete reconciles; a 304 counts as a repeated complete snapshot; suspicious snapshots do not advance the checkpoint; after `grace` consecutive suspicious snapshots the next is believed. The suspicion check counts newly absent listings only, or a confirmed closure would stall.

## Things not to forget

- `gh` billing usage is unreadable without the `user` scope, so actual Actions spend is unknown. Two `gh` accounts are logged in; `FeLZilber` is active.
- A hosted spike with one pass in each job costs about 20 runner minutes (28 measured with two passes in the second job).
- Docker is absent locally, so `docker-compose` cannot be exercised here unless installed. Record that as not live-tested.
- No Actions secrets, Neon project, Telegram bot, OAuth app or Vercel project exist. Operator steps go in `DEPLOYMENT.md`; do not claim any of them happened.
