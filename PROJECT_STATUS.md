# Project status

Resume document. Update after every milestone and any decision a new session could not re-derive.

- **Plan:** `Personal_Job_Hunter_Claude_Prompt.txt` in the repo root (gitignored, operator's local brief). Sections 18 (tests) and 21 (final report) define done.
- **Branch:** `mvp`, pushed. Default branch is `master`. Scheduled and dispatch workflows only operate once they reach `master`.
- **State:** MVP built and tested. **Not deployed.** Every remaining step needs an operator account. See `DEPLOYMENT.md`.
- **Last updated:** 2026-11-01

## Milestones

| Milestone | State |
| --- | --- |
| M0 Feasibility | Done. Final hosted run 41320394097 with the shipped defaults: 20 of 20 attempts valid. See `COSTS.md`. |
| M1 Durable ingestion | Done. Live-tested against real boards. Not deployed. |
| M2 Bounded AI | Done. Live-tested on local GPU and on a hosted runner (`pipeline-smoke`, 2 real postings). Not deployed. |
| M3 Notifications and automation | Done. Hosted CI and pipeline smoke green. Real Telegram delivery not tested: no bot exists. Schedules not active: they need `master` and secrets. |
| M4 Private dashboard and dev setup | Done. 26 E2E tests, CI 41320412960 and `compose-smoke` 41320413027 green at bd45bb3. Real GitHub sign-in not tested: no OAuth app exists. |
| M5 MVP hardening and handover | Done as far as access allows: docs written, failure tests complete, monthly cap added, benchmark and costs recorded. Live checks below remain blocked. |

## Acceptance

Plan section 21. "Blocked" means it needs an operator account or action. A mocked check does not count as live.

| # | Behavior | Implemented | Fixture-tested | Live-tested | Deployed |
| --- | --- | --- | --- | --- | --- |
| 1 | Greenhouse and Lever discovery, identity and links | Yes | Yes | Yes, 21 sources, 272 jobs | Blocked |
| 2 | Postgres persists before AI, no duplicates on repeat | Yes | Yes | Yes, throwaway Postgres | Blocked |
| 3 | Incremental avoids needless matching, full snapshots handled | Yes | Yes | Yes, second crawl all `not_modified` | Blocked |
| 4 | Partial or failed crawls never expire jobs, grace and reopening | Yes | Yes | Not exercised: no real closure or failure seen live | Blocked |
| 5 | Ollama in Docker on a hosted runner, within limits | Yes | Yes | Yes, runs 41320394097 and 41320412962 | Blocked |
| 6 | AI output validated, failures leave jobs and tasks intact | Yes | Yes | Valid output live. Failure paths fixture-only | Blocked |
| 7 | Matching-relevant changes invalidate stale results | Yes | Yes | No | Blocked |
| 8 | Telegram delivery, outbox retry and ambiguity | Yes | Yes | **Blocked: no bot** | Blocked |
| 9 | Scheduled and manual workflows, bounded maintenance | Yes | Yes | Shared pipeline passed in smoke. Schedules **blocked: need `master` and secrets** | Blocked |
| 10 | Owner-only dashboard | Yes | Yes, E2E with signed test sessions | **Blocked: no OAuth app** | Blocked |
| 11 | Automated tests pass, setup reproducible | Yes | 383 + 26 pass | CI green. Compose built on a runner, and run locally with Ollama from a fresh clone | n/a |
| 12 | No always-on PC, self-hosted runner, VPS or paid AI API | Yes | n/a | Holds by construction | Blocked |

## Blocked checks

| Check | Needs |
| --- | --- |
| Neon, including the pooler | A Neon project |
| Real Telegram delivery | A bot and chat id |
| Real GitHub sign-in | An OAuth app |
| Vercel deployment | A Vercel project |
| Scheduled runs | Merge to `master`, secrets, `PRODUCTION_ENABLED` |
| Actual Actions spend | Billing page, or a `gh` token with the `user` scope |
| Evaluation labels | A person to review them |

## Next operational steps

Follow `DEPLOYMENT.md`, then review the labels in `benchmarks/eval/dataset.json`. Check Actions use after the first week against `COSTS.md`.

## Known limitations

**Product**

- **Target-role recall is the main risk.** Of 1,776 raw postings across the catalog, 272 are in Israeli scope, and only one is plausibly a QA role (Cato "Automation Engineer"). This is catalog coverage, not a filter bug: these boards list few Israeli QA jobs. Do not pad the catalog with unverified sources. New ATS connectors are roadmap work and need separate authorization.
- **Catalog gap:** 19 Greenhouse and 2 Lever sources, few banks or government employers.
- **Human calibration is outstanding.** Evaluation labels are machine-proposed, so results measure agreement with a draft, not quality.
- **Evidence is weak,** especially in Hebrew: about a third of quotes are literal on hosted runs. Evidence is stored and shown as verified or not.
- **Scores vary across runners.** Same seed, 85 and 78 in one case, 15 and 23 in another, so a score near the threshold can flip.

**Runtime**

- **Runner speed spreads about threefold** (4.1 to 13 output tokens/s). `COSTS.md` plans for the slow end.
- **One 176 s outlier** on local GPU has no known cause. It predates the current limits.
- **Backlog runs newest first** within a priority, so old tasks wait longest.
- **The monthly cap blocks manual runs too,** and a killed run that records no finish is not counted against it.
- **Pending runs are replaced.** GitHub keeps only one pending run per concurrency group, so a queued run can be dropped.
- **Only variables listed in the workflows are honored.** `MAX_OUTPUT_TOKENS` and `OLLAMA_NUM_CTX` need a code change on Actions.
- **No secrets reach CI or smoke,** so the notify stage reports `not_configured` there.
- **No separate database backup.** Neon Free's restore history is 6 hours.

**Delivery**

- **Ambiguous sends wait for the operator,** and a missed alert is preferred to a duplicate.
- **A relevance change starts an epoch,** so older matching jobs do not alert. `--rematch-digest` shows them once, capped.
- **A suspicious snapshot needs confirmation:** after `grace` consecutive suspicious snapshots the next is believed, so a real mass closure is reported late.

**Cosmetic**

- The default next-auth sign-in page shows a broken logo, because the CSP blocks its image.

## Decisions a new session should keep

- **Model judges, code does arithmetic.** `score` and `recommendation` are derived from per-criterion `points`. Documented in `ARCHITECTURE.md`.
- **`MIN_MATCH_SCORE` is not implemented.** The threshold is a profile preference. Documented in `ARCHITECTURE.md`.
- **Database:** Neon Free. Supabase Free rejected (pauses after a week, 500 MB).
- **Secrets:** repository secrets, because environments are unavailable on private repositories on GitHub Free.
- **Docker builds** use `npm ci --ignore-scripts`.
- **Tests:** vitest global setup uses `TEST_DATABASE_URL` when set, otherwise `embedded-postgres`, so routine tests need neither a Docker engine nor an installed Postgres.
- **Locks:** transaction-scoped advisory locks only (safe with Neon pooling), plus leases for crawl claims.
- **Lever ETags:** stored only when a complete snapshot fit in one page, because a 304 proves a whole board unchanged only then.
- **Input key:** content hash, profile matching hash, match config hash (model digest, prompt, schema, rubric, inference options, input limit). The filter version is excluded on purpose: a filter release re-evaluates and reuses answers.
- **Ollama errors:** `unavailable` releases the claim with no attempt spent and stops the stage. `http` spends an attempt and stops, so one bad job cannot block the queue for ever. `timeout` spends an attempt and continues.
- **Truncation:** keeps the opening and the requirements section, because a head-only cut lost requirements on most long real postings.
- **Claiming:** a task is runnable only while its key is the job's current key and its profile hash is current, so stale work is never started even before `evaluate` reruns.
- **Freshness:** absence counts only on complete reconciles. A 304 counts as a repeated complete snapshot. Suspicious snapshots do not advance the checkpoint. The suspicion check counts newly absent listings only, or a confirmed closure would stall.
- **Seed:** `seed` applies catalog changes on each run, including `enabled: false`.
- **Outbox:** `notifications` rows are derived from committed match results in one transaction, with a unique `event_key`. The match transaction has no external side effects, so this is the documented equivalent of a transactional outbox.
- **Pipeline:** `.github/actions/pipeline` is shared by discovery, maintenance and smoke. Later stages run after a crawl or Ollama failure, and the job stays red.
- **Defaults come from measurements.** Change `src/config/budget.ts` and `COSTS.md` together. Shipped limits: output 1000, context 3200, timeout 330 s, input 1600, 8 jobs and 900 s per run, 800 AI minutes a month.

## Things not to forget

- Two `gh` accounts are logged in; `FeLZilber` is active.
- `NEXTAUTH_URL` must match the deployment URL.
- A hosted benchmark costs about 36 runner minutes and leaves a `-spike-` cache to delete.
- No Actions secrets, Neon project, Telegram bot, OAuth app or Vercel project exist. Do not claim any of them happened.
- Do not merge to `master` without the operator: that is step 7 of `DEPLOYMENT.md`.
