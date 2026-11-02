# Operations

## Workflows

| Workflow | Trigger | Does | Timeout |
| --- | --- | --- | --- |
| `discovery` | `17 */6 * * *` UTC, manual | Crawl, evaluate, match, notify, health | 38 min |
| `maintenance` | `41 3 * * *` UTC, manual | The same on the cheap ETag path with 2 AI jobs, then cleanup and a stale-discovery check | 30 min |
| `pipeline-smoke` | Pipeline changes on `mvp`, manual | The real pipeline against a throwaway Postgres | 25 min |
| `ci` | Push, pull request | Type-check, unit, integration, E2E. No secrets | 10 min |
| `compose-smoke` | Docker file changes, manual | Builds the image and checks the local setup | 15 min |
| `ollama-feasibility` | Benchmark changes on `mvp`, manual | Hosted benchmark. It costs about 36 runner minutes | 35 min per job |

`discovery` and `maintenance` run only when the repository variable `PRODUCTION_ENABLED` is `true`.

### Manual discovery inputs

| Input | Effect |
| --- | --- |
| `mode` | `full` ignores ETags. Unchanged jobs are still not rematched |
| `provider`, `company` | Crawl a subset. Absence is not judged for sources outside it |
| `retry-failed` | Reopens exhausted AI tasks |
| `force-rematch` | Queues every eligible job, then works through it within caps. Starts an epoch |
| `notify-dry-run` | Reports what would be sent without sending |
| `rematch-digest` | Sends one capped digest of older matches after a relevance change |
| `retry-ambiguous` | Resends ambiguous deliveries. Check the chat first |

### Repository variables

Blank means the default. Workflows read only the names below, so other settings need a code change.

`MAX_AI_JOBS_PER_RUN`, `AI_TIME_BUDGET_SECONDS`, `AI_MINUTES_PER_MONTH`, `INFERENCE_TIMEOUT_SECONDS`, `MAX_JOB_INPUT_TOKENS`, `CRAWL_TIME_BUDGET_SECONDS`, `MAX_ALERTS_PER_RUN`, `NOTIFY_TIME_BUDGET_SECONDS`, `STALE_DISCOVERY_HOURS`, `RETENTION_DAYS`

Before raising a time budget, check it against the job's `timeout-minutes`. `AI_TIME_BUDGET_SECONDS` must stay above `INFERENCE_TIMEOUT_SECONDS`, or no job starts. Discovery's 38 minutes covers the default 900 s budget and no more.

## Daily check

The dashboard's status page shows everything below. `worker health` prints the same to the run summary.

| Signal | Healthy | If not |
| --- | --- | --- |
| Last successful crawl | Under 14 h | See "Discovery is stale" |
| Source failures | None | One board failing for a run is normal; investigate if it repeats |
| AI backlog | Falling or empty | See "Backlog" |
| AI time this month | Below 800 min | See "Monthly AI budget" |
| Ambiguous or failed notifications | None | See "Ambiguous delivery" |

## Runbook

### Discovery is stale

`maintenance` fails when no crawl succeeded within `STALE_DISCOVERY_HOURS`, because a red run is how this reaches the owner. GitHub can delay or drop scheduled runs, so one miss is not a fault: run `discovery` by hand. If runs are missing altogether, check:

- `PRODUCTION_ENABLED` is `true`.
- Actions is not blocked for billing. Without a payment method, GitHub blocks Actions when the included amount is used.
- The workflow is on `master`.

### Backlog

A run matches up to 8 jobs in 900 s and starts jobs only until 570 s. Slow runners complete about 3 long jobs. Anything left stays pending for the next run. Tasks are taken by priority, then newest first, so fresh jobs get a verdict quickly and old tasks can wait during a long backlog. The health report shows the oldest task's age.

A backlog that keeps growing means more jobs pass the filter than the budget can match. Narrow the profile before raising limits, then see `COSTS.md`.

`exhausted` tasks failed `MAX_MATCH_ATTEMPTS` times. They show as failed on the dashboard. Read the run log, fix the cause, then use `retry-failed`.

### Monthly AI budget

Past `AI_MINUTES_PER_MONTH`, Ollama stays off for the rest of the UTC month and the log says so. Discovery and notifications keep working, tasks stay pending, and manual runs are held back as well. Raise the variable only after checking GitHub's actual spend, and reduce it again next month. Runs killed by a timeout have no finish time and are not counted, so a month with many killed runs uses more than this figure shows.

### Model problems

| Stop reason | Meaning | Action |
| --- | --- | --- |
| `model_unavailable` | Ollama did not answer. No attempt spent | Read the `ollama-start` step |
| `digest_mismatch` | The model is not the locked one. Nothing ran | See `OLLAMA_SETUP.md` |
| `model_error` | Ollama returned an HTTP error. One attempt spent | Read the run log. The next run continues |
| `time_budget`, `job_cap` | Normal deferral | None |

The job's AI results are never lost: completed matches are committed one at a time.

### Ambiguous delivery

A request may or may not have reached Telegram, so the event is held. Open the chat:

- **The message arrived:** leave it. It stays recorded as ambiguous, and nothing resends it.
- **It did not arrive:** run `discovery` with `retry-ambiguous`.

`retry-ambiguous` reopens every ambiguous event at once, so a message that did arrive is sent twice. That is the accepted cost.

### Telegram errors

`misconfigured` (bad token or chat) stops delivery with events still queued. Fix the secret and the next run delivers them. Rejected messages fail without retries, and their error is on the status page. A long `retry_after` ends the run's sending and the next run resumes.

### Dashboard errors

A sign-in loop usually means `NEXTAUTH_URL` does not match the deployment URL, or the OAuth callback does not. Reaching the denied page as the owner means `OWNER_GITHUB_ID` holds the wrong id. The error page has a retry button. If it keeps failing, check `DATABASE_URL` and the Neon project state.

### Neon limits

When compute or egress is used up, the project suspends until the next period. Crawls then fail visibly and no data is lost. If storage reaches 1 GB, writes fail: lower `RETENTION_DAYS` and let `cleanup` run.

## Maintenance

`cleanup` removes run history, snapshots and superseded tasks older than `RETENTION_DAYS` (90), keeping anything still referenced. Jobs, listings, events, results and notifications are retained.

To add a source, verify it live, then add it to `catalog/sources.json` with the verification URL and date. Never add an unverified endpoint. The `seed` step applies the catalog on the next run, including `enabled: false` to pause a source.

A catalog entry must respect the provider's terms and `robots.txt`. Lever declares `Crawl-delay: 1`, which the connector honors.

To change the model, see `OLLAMA_SETUP.md`. A new digest invalidates every result, so the whole eligible set is rematched over several runs.

Profile edits on the dashboard start a new epoch, so existing jobs do not alert. Use `rematch-digest` to see older jobs that now match.
