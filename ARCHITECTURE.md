# Architecture

A single TypeScript package. The CLI worker runs on GitHub Actions and the Next.js dashboard runs on Vercel. Both share `src/` and one PostgreSQL database, and neither calls the other.

## Data flow

```
Greenhouse, Lever, Ashby, Workable
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
| `src/connectors` | Greenhouse, Lever, Ashby, Workable and Workday clients, plus an opt-in generic `jsonld` reader |
| `src/http` | Crawler HTTP client with DNS-aware SSRF protection |
| `src/normalize` | Location, technology, seniority and text normalization |
| `src/ingest` | Crawl, identity, lifecycle and events |
| `src/filter` | Deterministic shortlist rules |
| `src/profile` | Profile schema, revisions and hashes |
| `src/match` | Prompt, schema, queue, runner and Ollama client |
| `src/notify` | Outbox, message rendering and Telegram client |
| `src/worker` | CLI and maintenance |
| `src/dashboard`, `src/app` | Server-side queries and auth, and Next.js pages |
| `catalog/sources.json` | Verified sources. 94 entries: 47 Greenhouse, 4 Lever, 16 Ashby, 27 Workday. Grown with `npm run catalog:add` and `npm run catalog:discover`; Workday sites are added by link (`catalog:add --url`); `jsonld` entries (key is an https URL) are added by hand |
| `ollama/model-lock.json` | Pinned image, model and digest |

## Identity and lifecycle

A listing is identified by provider, source and provider job id. Canonical deduplication is conservative: listings merge only on strong evidence, because a wrong merge hides a job.

A job moves between `active` and `expired`:

- **Absence counts only on a complete reconcile.** A partial, failed or blocked crawl never expires anything.
- **A 304 counts as a repeated complete snapshot.** Lever ETags are kept only when one page held the whole board, because otherwise a 304 proves nothing about the rest.
- **Suspicious snapshots do not advance the checkpoint.** A snapshot losing more than `SUSPICIOUS_DROP_RATIO` of listings is held back. After `FRESHNESS_GRACE_SNAPSHOTS` such snapshots in a row, the next is believed, so a real mass closure still lands.
- **Reopening starts a new lifecycle cycle.** Events are keyed by cycle, so a reopened job can alert again without replays duplicating anything.

## Matching

`evaluate` applies the filter and queues work without a model. Every evaluation stores the filter's deterministic priority. After evaluating, a fill step tops the queue up to `AI_QUEUE_LIMIT` open tasks with the best-ranked eligible jobs that have no result and no task (a superseded task may reopen, an exhausted one never does); the rest are deferred and picked up as the queue drains. A task's input key combines the content hash, the profile matching hash and the match config hash (model digest, prompt, schema, rubric, inference options and input limit).

- An unchanged key is never rematched, so a full crawl does not re-run AI.
- A changed key queues new work and marks the old result stale. Stale results stay readable and labelled.
- A filter version is left out of the key on purpose: a filter release re-evaluates and reuses existing answers.
- A chip, board or factory title ("Chip Design Verification Engineer", "IC Test Engineer", "Manufacturing Quality Engineer") is rejected as `hardware_discipline` unless the description names software test tools. These roles share "verification", "validation", "test" and "quality" with software QA, and hardware employers list them by the dozen.
- A job can pass on its description alone when the title does not rule it out. Other engineering disciplines (DevOps, backend, data and similar) are rejected on the title, because they mention test tools as part of their own stack. A plain "Software Engineer" is not, because it can hide an SDET role.

**Two tiers: strict and adjacent.** The filter's own verdict is the strict tier, and it alone is queued for the model and alerted. The adjacent tier is roles near the target (DevOps, SRE, support and solutions engineering, release and build engineering) that the filter rejects only for being a different role. It is shown on the Filtered out page and nowhere else: never queued, never scored, never alerted. `src/filter/tiers.ts` computes the tier at display time from the stored decision. A job is adjacent when every rejection reason is role-only (`no_qa_signal`, `title_other_discipline`, `title_other_engineering`, `industrial_automation`, `hardware_discipline`), so a hard rule such as location, seniority or an excluded term still excludes it, and its title contains one of the owner's `adjacentTitles` as a whole word or phrase. The terms live in preferences, not the matching profile, because the matching hash is part of every task's input key: changing the terms re-queues nothing and starts no notification epoch. The tier is not stored, so editing the terms takes effect immediately and `applyFilter`, `FILTER_VERSION` and the queue are untouched, which keeps the alert set unchanged by construction. The integration test runs the pipeline with no terms and with the defaults and compares evaluations, tasks and notifications.

**The model judges language and the code scores the facts.** The plan's contract has the model return `score` and `recommendation`. Here the model returns only a role category, the requirements it found, evidence quotes and an explanation. Code computes every point under `rubric-v2` (`src/match/facts.ts`): role 35 from the model's category, then skills 25, experience 15, seniority 10, location 10 and industry 5 from the structured facts the pipeline already extracted. Missing facts score neutral, not zero. A small CPU model counts and compares unreliably (the same input scored 85 on one runner and 78 on another), and a posting cannot talk code into a higher score. It also shortens the model's output. This is a deliberate deviation.

**The alert threshold is a profile preference.** The plan names a `MIN_MATCH_SCORE` environment variable. It is deliberately not implemented, because the owner edits the threshold on the dashboard (default 75), and a change there starts a new epoch like any other relevance change. A second setting in the environment could only disagree with it.

Output is validated with Zod. Evidence quotes are checked against the posting and stored as verified or unverified, because literal evidence from this model is weak, especially in Hebrew. A failed evaluation stays a failure and is never turned into a score of zero. Job text is untrusted, and the model gets no tools, secrets or network access.

**Queue guarantees.** Tasks are claimed by priority, then newest posting first, so a small budget goes to fresh jobs. Older postings stay eligible. Claims are leased, so an abandoned claim is recovered. `drainQueue` starts a job only if a full inference timeout still fits before the deadline. It therefore cannot overrun the budget, and a budget below the timeout runs nothing. `unavailable` releases the claim without spending an attempt. `timeout` spends one and continues. `http` spends one and stops. A task becomes `exhausted` after `MAX_MATCH_ATTEMPTS`, and a run reports the backlog count and oldest task age.

## Notifications

The outbox is derived from committed match results and identified by a unique `event_key`, so a replay cannot duplicate a row. This stands in for a transactional outbox because the match transaction has no external side effects.

- **Rechecked before sending.** A queued event is judged against the database as it is then, and suppressed if the job closed or fell below the threshold.
- **Baselines give capped digests per source**, not one alert per job. While a source's first crawl is still being judged, each run sends one digest of the jobs that qualified since the last, so the best-ranked jobs arrive the day they are scored and not after the last unlikely one. A job is never listed twice. When every baseline job has a verdict, a closing row under the source's own key (the last digest, or a suppressed marker) ends it, and a later rematch cannot raise a digest for that source. An eligible job still waiting outside the capped AI queue keeps the baseline open.
- **Relevance changes start an epoch.** Events from before it get no alert, which stops a profile edit from flooding the chat. Those jobs appear on the dashboard, and `--rematch-digest` sends one capped digest per epoch.
- **Ambiguous delivery is held, not resent.** `send_started_at` commits before the request. Telegram has no idempotency key, so a lost acknowledgement stays `ambiguous` until the operator checks the chat. A missed alert is preferred to an unbounded duplicate.

## Workday connector

`provider: "workday"` reads a Workday career site. `providerKey` is the site's address, `https://{tenant}.wd{N}.myworkdayjobs.com/{site}`, taken from any link on it. The site's own search endpoint lists postings (`POST /wday/cxs/{tenant}/{site}/jobs`, 20 a page) and a second request per posting returns the description. Both go through `HttpClient`, so the tenant's `robots.txt`, the SSRF guard and pacing apply; `HttpClient.postJson` exists for this connector and gets the same checks as a GET.

A tenant can list thousands of jobs worldwide, so the first request reads the location facets and every later one is narrowed to Israel: the country value when the tenant has one, otherwise every site whose name mentions Israel. Postings are yielded page by page with their descriptions, at most 50 pages (1000 Israeli postings).

- A failed or malformed description, a page limit, or fewer postings than the first page announced makes the crawl `partial`, so nothing expires.
- A site with location facets and no Israeli value is a `complete` empty snapshot. Reconciliation still holds back a sudden mass disappearance as `suspicious`. A response with no location facet at all is `failed`.
- No ETag is stored: the listing is a POST, so every crawl reads every Israeli posting again. NVIDIA, the largest site in the catalog, took 160 to 216 s for 408 postings locally (2026-11-12) and did not finish inside 300 s on a hosted runner, which is why the crawl budget defaults to 600 s. A posting whose description cannot be read is requested once more before it counts against the crawl, and the snapshot error names the first one. New and previously incomplete sources are crawled first, so a source cut off by `CRAWL_TIME_BUDGET_SECONDS` goes to the front of the next run.
- The posting id is Workday's own id, not the URL path, because the path contains the title.

## JSON-LD connector

`provider: "jsonld"` reads `schema.org/JobPosting` JSON-LD from a company's own careers page or job sitemap. It is opt-in: a catalog entry sets `providerKey` to the https URL, and `catalog:add` never guesses one. A URL ending in `.xml` is a sitemap: the connector takes same-host https `<loc>` entries (at most 150, beyond that the crawl is `partial`) and fetches each page, committing page by page. Any other URL is read as a single page. Everything goes through `HttpClient`, so the SSRF guard, pacing and (once merged) robots.txt apply.

A page with zero JobPostings is a `failed` crawl, never a `complete` empty one, because a redesign that drops the markup must not expire every job. A malformed block, an unusable posting or a failed detail page makes the crawl `partial`. No ETag is stored and `not_modified` is never returned: these pages change on every request, so a 304 would not prove the board is unchanged, and an unconditional 304 is treated as a failure. Postings with a past `validThrough` are skipped as closed. A posting with no `identifier` or URL gets the page URL plus its title as id, which is weaker: a retitled posting looks like a new job.

## Dashboard

Every page starts with `await requireOwner()` and so does every server action. A static test fails if one does not. Access requires the numeric GitHub id in `OWNER_GITHUB_ID`, which unlike a username cannot be reassigned. Signing in with any other account is refused at the callback and again on each request.

Source text renders as plain text, so no posting HTML reaches the browser. The dashboard reads and writes through server-only modules, and the CSP blocks third-party scripts, images and framing. Saved jobs, applications and dismissals are separate tables (`saved_jobs`, `job_applications`, `dismissed_jobs`) from job lifecycle status, so an expired or reopened posting never changes what the owner marked. Applying is a single mark with a date, set from the job page and undone the same way. It does not stop alerts for that job. "Not relevant" takes a reason (wrong role, seniority, location or company), hides the job from the main lists, and lists it on the Dismissed page with a tally. Dismissing does not yet change scoring or alerts. The Filtered out page is a rejection audit: it counts the filter's reasons for active jobs, lists the rejected jobs, and lets the owner flag one as "should have matched" (`missed_jobs`). The page also marks adjacent roles (see Matching), counts them, and can list only those (`?tier=adjacent`); the terms are edited on the Profile page. Flags do not change scoring; they are evidence for filter fixes, and the page tallies the filter reasons behind the flagged jobs to show which rule to fix. Job lists mark a current score whose cited quotes were not all found in the posting. Interview stages and notes are roadmap work and are not built.

The job list can filter and sort by posting date, using the discovery date when a provider gives none. The default shows every open job, so an old posting that is still open is never hidden silently. `/search` builds links for the owner to open by hand, one for each site the worker does not crawl. Nothing there is fetched by the worker, and the jobs it finds are not tracked.

## Budget controls

Four limits apply, from narrowest to widest:

| Limit | Default | Enforced by |
| --- | --- | --- |
| Per job | 330 s, 1000 output tokens, 1600 input tokens | `OllamaClient`, `buildMatchConfig` |
| Per run | 8 jobs, 900 s | `drainQueue`, stage `timeout`, job `timeout-minutes` |
| Queue | 40 open tasks (`AI_QUEUE_LIMIT`, 0 = no AI work) | `fillQueue` queues the best-ranked jobs only |
| Per month | 800 AI minutes | `pending` keeps Ollama off once spent; tasks stay queued |

The monthly cap exists because a backlog that never clears would spend the Actions allowance, and GitHub would then block discovery too. See `COSTS.md`.

## Concurrency

Workflows share the `job-hunter-worker` concurrency group, and migrate, evaluate and notification planning take transaction-scoped advisory locks (safe through Neon's pooler). Crawl claims are leases on `job_sources`. `withTransaction` retries the whole unit on a transient failure, so no network call happens inside one.

## Trade-offs

- **Recall depends on the catalog.** The owner can add a company from `/search` by pasting a Greenhouse, Lever, Ashby, Workable or Workday link; the `adopt` step probes it and keeps it only if it lists Israeli jobs. These boards list few Israeli QA jobs. Comeet is left out on purpose, see `PROJECT_STATUS.md`. Other ATS connectors are roadmap work.
- **Daily discovery is not real time.** GitHub can delay or drop scheduled runs, so a job can wait a day or more before it is seen.
- **Scores vary across runners.** The same seed gave `mixed-sdet` 63 on one runner and 78 and 85 on others. Treat a score as a band, not a measurement.
- **Single owner, single profile.** Multi-user support is out of scope.
