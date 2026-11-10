# Testing

Results below are what was actually run, with the date and place. A fixture test does not show that a provider works live, and a mocked integration does not count as live verification.

## Routine tests

These need no real model, production database, paid API or Telegram message. CI runs them on every push and pull request, with no secrets.

```sh
npm run typecheck
npm test            # unit and integration
npm run test:e2e    # production build, then Playwright
```

| Suite | Tests | Runs against |
| --- | --- | --- |
| Unit and integration | 407 in 17 files | Isolated PostgreSQL, mocked providers, scripted model |
| Dashboard E2E | 33 | The production build in Chromium, a seeded database and signed test sessions |

`tests/setup/postgres.ts` uses `TEST_DATABASE_URL` when set. Otherwise it starts `embedded-postgres`, as CI does, so no Docker is needed. Tests truncate tables, so never point `TEST_DATABASE_URL` at a real database.

E2E installs a browser once: `npx playwright install chromium`. CI installs only the headless shell (`--only-shell`), which is all a headless run needs, and skips `--with-deps`: the runner image already has the system libraries, and the extra fonts serve no test.

### E2E authentication

GitHub sign-in is not exercised. The tests mint session cookies with the test secret, so they cover the app's authorization but not the OAuth exchange. That needs the real app, and it is an activation check in `DEPLOYMENT.md`.

### What the routine tests cover

- **Connectors:** pagination, conditional requests, timeouts, rate limits.
- **Ingestion:** repeated and concurrent runs, no expiry after partial, failed, blocked or suspicious snapshots, grace rule, reopening.
- **AI:** persistence before matching, invalid output, bounded retries, abandoned claims, model outage, digest mismatch, stale work, reuse of unchanged results.
- **Notifications:** outbox uniqueness, retries, ambiguous acknowledgement, suppression of obsolete events, token redaction.
- **Dashboard:** owner-only access on every page and action, wrong-secret sessions, replayed server actions, hostile posting text, Hebrew search, posting date filter, search links, phone width, security headers.
- **Budgets:** workflow budgets exceed the inference timeout, shipped defaults fit the model context, the monthly cap holds Ollama off and leaves tasks queued.

## Opt-in checks

These use real services or runner minutes, so they run only when chosen.

| Check | Command or trigger | Cost |
| --- | --- | --- |
| Live ingestion | `npm run check:live-ingest` | Reads public boards. No model |
| Live ingestion and matching | `LIVE_MATCH_JOBS=8 AI_TIME_BUDGET_SECONDS=800 npm run check:live-ingest` | Needs local Ollama |
| Evaluation set | `npx tsx benchmarks/eval/run.ts` | Needs local Ollama |
| Local benchmark | `npx tsx benchmarks/ollama/run.ts --label local --passes 1` | Needs local Ollama |
| Hosted benchmark | `ollama-feasibility` workflow | About 36 runner minutes |
| Hosted pipeline | `pipeline-smoke` workflow | About 7 runner minutes |
| Local Docker setup | `compose-smoke` workflow | About 1 runner minute |

## Live results

### Catalog growth, 2026-11-08, real boards, throwaway database, `catalog/discover-sources`

Same day, same filter (`filter-v4`), before and after adding the 30 sources found by `catalog:discover`. Crawl, then `evaluate`; no model ran.

| Catalog | Sources (complete) | Listings seen | Israeli jobs | Eligible after filter |
| --- | --- | --- | --- | --- |
| `master`, 37 sources | 37 | 2,821 | 454 | 13 |
| This branch, 67 sources | 67 | 3,752 | 596 | 14 |

One existing source (`greenhouse:perionnetworkltd`) listed no Israeli job on that day.

### Ingestion, 2026-11-02, real boards, throwaway database, `search-recall`

Crawl stage only, with Ashby and the nine new sources.

| Run | Duration | Snapshots | Canonical jobs | Listings | Duplicate keys |
| --- | --- | --- | --- | --- | --- |
| First | 8.3 s | 30 complete | 377 | 377 | 0 |
| Second | 6.8 s | 30 `not_modified` | 377 | 377 | 0 |

Under `filter-v2`, 366 were rejected and 11 stayed eligible: `no_qa_signal` 292, `title_other_discipline` 67, `title_other_engineering` 7, `excluded_employment_type` 2, `experience_far_above_candidate` 1. No model ran. This branch has not run against production.

### Ingestion, 2026-11-01, real boards, throwaway database

| Run | Duration | Snapshots | Canonical jobs | Listings | Duplicate keys |
| --- | --- | --- | --- | --- | --- |
| First | 22 s | 21 complete | 272 | 272 | 0 |
| Second | 7 s | 21 `not_modified` | 272 | 272 | 0 |

A later run on the same day took 7.8 s and 6.1 s for the crawl stage alone.

### Matching, 2026-11-01, local GPU, real postings

272 active jobs, 261 rejected by the filter, 11 eligible. A second `evaluate` did nothing. 8 scored with 0 failures, 4 of them on truncated input. One job took 176 s, cause unknown. This run predates the current output limit.

### Hosted checks, 2026-11-01, commit bd45bb3, `ubuntu-24.04`

| Run | Workflow | Job time | Result |
| --- | --- | --- | --- |
| 41320412960 | `ci` | 1 min 2 s tests, 1 min 14 s E2E | Passed |
| 41320412962 | `pipeline-smoke` | 6 min 21 s | Passed. See below |
| 41320413027 | `compose-smoke` | 1 min 1 s | Passed. See below |

`pipeline-smoke` used a throwaway Postgres and the real pipeline. It crawled live boards in 6.1 s, evaluated 274 jobs (11 eligible, 263 rejected), and scored 2 real postings on the runner's CPU in 207 s with 0 failures. The job cap stopped it and left 9 tasks pending. Notify reported `not_configured`, because the workflow holds no secrets.

`compose-smoke` built the image, ran `migrate` twice (the second applied nothing), `seed`, `evaluate` and `pending`. The dashboard answered and redirected `/` to sign-in. `evaluate` had no jobs to read, because it does not crawl.

Earlier hosted failures on commit ebab100 found a real defect: the new output limit made the default configuration fail its context guard, which stopped every worker command that builds the match config. It was fixed in 6f2dd1f, and a unit test now builds the shipped defaults.

### Hosted benchmark, 2026-11-01, commit 6f2dd1f, run 41320394097

Shipped defaults, 10 synthetic samples (2 at the input limit), one pass, one job on a cold cache and one on a cache hit. Data is in `benchmarks/results/hosted-ubuntu-24.04-2026-11-01-final.json`.

| Measure | Cache miss | Cache hit |
| --- | --- | --- |
| Job duration | 16.9 min | 19.2 min |
| Runner CPU | AMD EPYC 7763 | Intel Xeon 6973P-C |
| First call | 220.2 s | 178.6 s |
| Warm attempts, ok of total | 9 of 9 | 9 of 9 |
| Median / max inference | 67.3 / 226.7 s | 85.9 / 190.5 s |
| Median output speed | 6.6 tokens/s | 4.7 tokens/s |
| Peak container memory | 2486 MiB | 2749 MiB |
| Literal evidence | 11 of 34 | 12 of 32 |

All 20 attempts returned valid output, with no truncation and no timeouts. The longest answer used 845 of 1000 output tokens. Two jobs on two runners show a range and nothing more. `COSTS.md` lists every run, including the earlier failures that set these limits.

### Local Compose, 2026-11-01, commit 34eb154, Docker Desktop on Apple M2 Pro

The `README.md` steps in a fresh clone with `.env` copied from `.env.example`, against real boards, with the `ollama` profile. The Docker VM had 12 vCPU and 8 GB of memory. Throwaway OAuth values were used, so sign-in itself was not exercised.

| Step | Result |
| --- | --- |
| `migrate` twice, `seed` | Passed |
| `crawl` | 7.1 s, 274 active jobs |
| `evaluate` | 11 eligible, 263 rejected, 11 queued |
| Dashboard | `/denied` answered, `/` redirected to sign-in |
| Ollama | No port published. `ollama list` showed the locked `357c53fb659c`, and `match` verified the full digest |
| `match` | 8 of 8 scored, 0 failures, 0 validation retries, 4 truncated inputs, 467.5 s. It stopped at the job cap with 3 pending |
| `notify --dry-run` | Nothing to send. The top score was 70, below the default threshold of 75 |
| `health` | Fresh, 0 exhausted, 8 AI minutes this month |

The first job took 254 s and the other seven 23 to 39 s, cause not established. Ollama held 2.8 GiB after the run. This is one run on one machine, and it says nothing about hosted speed.

## Evaluation set

`benchmarks/eval/dataset.json` holds 20 **synthetic** examples with **machine-proposed labels**. **No person has reviewed them.** Results measure agreement with a draft, not quality. Human calibration is outstanding, and precision and recall are not reported for that reason.

Local GPU, prompt v2, results in `benchmarks/results/eval-local-2026-11-01.json`:

| Split | Filter agreement | Relevant rejected | Scored | Failures | Role agreement | Alerts on relevant / alerts |
| --- | --- | --- | --- | --- | --- | --- |
| tune | 10/10 | 0 | 6 | 0 | 5/6 | 4/4 |
| heldout | 10/10 | 0 | 6 | 0 | 6/6 | 3/3 |

An injection example embedded in a posting scored 55 locally and 25 on hosted runners, so it did not push the score to an alert. One example is no proof of resistance.

## Not tested

| Check | Why |
| --- | --- |
| Real Telegram delivery | No bot exists |
| Real GitHub sign-in | No OAuth app exists |
| Neon, including its connection pooler | No project exists. Tests use plain Postgres 18 |
| Vercel deployment | No project exists. The production build runs locally and in CI |
| Scheduled workflow runs | None has fired yet. See `PROJECT_STATUS.md` |
| Human review of the evaluation labels | Needs a person |
