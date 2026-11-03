# Architecture

A single TypeScript package. The CLI worker runs on GitHub Actions and the Next.js dashboard runs on Vercel. Both share `src/` and one PostgreSQL database, and neither calls the other.

## Data flow

```
Greenhouse, Lever, Ashby
      │  crawl: conditional requests, SSRF-safe client
      ▼
source_snapshots ─► source_listings ─► canonical_jobs ─► job_events
                                             │
                                             │  evaluate: deterministic filter, no model
                                             ▼
                                    job_evaluations ─► match_tasks
                                                           │
                                                           │  match: Ollama on the runner, within budget
                                                           ▼
                                                     match_results ─► notifications ─► Telegram
```

Each stage commits before the next starts, so jobs are never lost to a later failure. The stages run in order on the runner:

1. `migrate` and `seed`
2. `crawl`
3. `evaluate`, then `pending`, which decides whether Ollama starts
4. `match`
5. `notify`
6. `cleanup`, on maintenance runs only
7. `health`

| Directory | Holds |
| --- | --- |
| `src/connectors` | Greenhouse, Lever and Ashby clients |
| `src/http` | Crawler HTTP client with DNS-aware SSRF protection |
| `src/normalize` | Location, technology, seniority and text normalization |
| `src/ingest` | Crawl, identity, lifecycle and events |
| `src/filter` | Deterministic shortlist rules |
| `src/profile` | Profile schema, revisions and hashes |
| `src/match` | Prompt, schema, queue, runner and Ollama client |
| `src/notify` | Outbox, message rendering and Telegram client |
| `src/worker` | CLI and maintenance |
| `src/dashboard`, `src/app` | Server-side queries and auth, and Next.js pages |
| `catalog/sources.json` | Verified sources. 37 entries: 30 Greenhouse, 3 Lever, 4 Ashby. Grown with `npm run catalog:add` |
| `ollama/model-lock.json` | Pinned image, model and digest |

## Identity and lifecycle

A listing is identified by provider, source and provider job id. Canonical deduplication is conservative: listings merge only on strong evidence, because a wrong merge hides a job.

A job moves between `active` and `expired`:

- **Absence counts only on a complete reconcile.** A partial, failed or blocked crawl never expires anything.
- **A 304 counts as a repeated complete snapshot.** Lever ETags are kept only when one page held the whole board, because otherwise a 304 proves nothing about the rest.
- **Suspicious snapshots do not advance the checkpoint.** A snapshot losing more than `SUSPICIOUS_DROP_RATIO` of listings is held back. After `FRESHNESS_GRACE_SNAPSHOTS` such snapshots in a row, the next is believed, so a real mass closure still lands.
- **Reopening starts a new lifecycle cycle.** Events are keyed by cycle, so a reopened job can alert again without replays duplicating anything.

## Matching

`evaluate` applies the filter and queues work without a model. A task's input key combines the content hash, the profile matching hash and the match config hash (model digest, prompt, schema, rubric, inference options and input limit).

- An unchanged key is never rematched, so a full crawl does not re-run AI.
- A changed key queues new work and marks the old result stale. Stale results stay readable and labelled.
- A filter version is left out of the key on purpose: a filter release re-evaluates and reuses existing answers.
- A job can pass on its description alone when the title does not rule it out. Other engineering disciplines (DevOps, backend, data and similar) are rejected on the title, because they mention test tools as part of their own stack. A plain "Software Engineer" is not, because it can hide an SDET role.

**The model judges and the code does the arithmetic.** The plan's contract has the model return `score` and `recommendation`. Here it returns per-criterion `points`, and `score` and `recommendation` are derived in code. A small CPU model adds up unreliably, and derived values cannot contradict the points. This is a deliberate deviation.

**The alert threshold is a profile preference.** The plan names a `MIN_MATCH_SCORE` environment variable. It is deliberately not implemented, because the owner edits the threshold on the dashboard (default 75), and a change there starts a new epoch like any other relevance change. A second setting in the environment could only disagree with it.

Output is validated with Zod. Evidence quotes are checked against the posting and stored as verified or unverified, because literal evidence from this model is weak, especially in Hebrew. A failed evaluation stays a failure and is never turned into a score of zero. Job text is untrusted, and the model gets no tools, secrets or network access.

**Queue guarantees.** Tasks are claimed by priority, then newest posting first, so a small budget goes to fresh jobs. Older postings stay eligible. Claims are leased, so an abandoned claim is recovered. `drainQueue` starts a job only if a full inference timeout still fits before the deadline. It therefore cannot overrun the budget, and a budget below the timeout runs nothing. `unavailable` releases the claim without spending an attempt. `timeout` spends one and continues. `http` spends one and stops. A task becomes `exhausted` after `MAX_MATCH_ATTEMPTS`, and a run reports the backlog count and oldest task age.

## Notifications

The outbox is derived from committed match results and identified by a unique `event_key`, so a replay cannot duplicate a row. This stands in for a transactional outbox because the match transaction has no external side effects.

- **Rechecked before sending.** A queued event is judged against the database as it is then, and suppressed if the job closed or fell below the threshold.
- **Baselines give one capped digest per source**, not one alert per job.
- **Relevance changes start an epoch.** Events from before it get no alert, which stops a profile edit from flooding the chat. Those jobs appear on the dashboard, and `--rematch-digest` sends one capped digest per epoch.
- **Ambiguous delivery is held, not resent.** `send_started_at` commits before the request. Telegram has no idempotency key, so a lost acknowledgement stays `ambiguous` until the operator checks the chat. A missed alert is preferred to an unbounded duplicate.

## Dashboard

Every page starts with `await requireOwner()` and so does every server action. A static test fails if one does not. Access requires the numeric GitHub id in `OWNER_GITHUB_ID`, which unlike a username cannot be reassigned. Signing in with any other account is refused at the callback and again on each request.

Source text renders as plain text, so no posting HTML reaches the browser. The dashboard reads and writes through server-only modules, and the CSP blocks third-party scripts, images and framing. Saved jobs, applications and dismissals are separate tables (`saved_jobs`, `job_applications`, `dismissed_jobs`) from job lifecycle status, so an expired or reopened posting never changes what the owner marked. Applying is a single mark with a date, set from the job page and undone the same way. It does not stop alerts for that job. "Not relevant" takes a reason (wrong role, seniority, location or company), hides the job from the main lists, and lists it on the Dismissed page with a tally. Dismissing does not yet change scoring or alerts. Interview stages and notes are roadmap work and are not built.

The job list can filter and sort by posting date, using the discovery date when a provider gives none. The default shows every open job, so an old posting that is still open is never hidden silently. `/search` builds links for the owner to open by hand, one for each site the worker does not crawl. Nothing there is fetched by the worker, and the jobs it finds are not tracked.

## Budget controls

Three limits apply, from narrowest to widest:

| Limit | Default | Enforced by |
| --- | --- | --- |
| Per job | 330 s, 1000 output tokens, 1600 input tokens | `OllamaClient`, `buildMatchConfig` |
| Per run | 8 jobs, 900 s | `drainQueue`, stage `timeout`, job `timeout-minutes` |
| Per month | 800 AI minutes | `pending` keeps Ollama off once spent; tasks stay queued |

The monthly cap exists because a backlog that never clears would spend the Actions allowance, and GitHub would then block discovery too. See `COSTS.md`.

## Concurrency

Workflows share the `job-hunter-worker` concurrency group, and migrate, evaluate and notification planning take transaction-scoped advisory locks (safe through Neon's pooler). Crawl claims are leases on `job_sources`. `withTransaction` retries the whole unit on a transient failure, so no network call happens inside one.

## Trade-offs

- **Recall depends on the catalog.** These boards list few Israeli QA jobs. Comeet is left out on purpose, see `PROJECT_STATUS.md`. Other ATS connectors are roadmap work.
- **Six-hourly discovery is not real time.** GitHub can delay or drop scheduled runs, and maintenance gives a daily second chance.
- **Scores vary across runners.** The same seed gave `mixed-sdet` 63 on one runner and 78 and 85 on others. Treat a score as a band, not a measurement.
- **Single owner, single profile.** Multi-user support is out of scope.
