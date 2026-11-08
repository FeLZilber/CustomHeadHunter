# Costs

The system is built to run for free inside GitHub's included Actions usage, Neon Free and Vercel Hobby. This file separates what was measured from what is estimated. No production workload has run yet, so every monthly figure below is an estimate.

Provider facts were checked on 2026-11-01 and can change. Check the linked pages before relying on them.

## Summary

| Case | Runner minutes a month | Spend at $0.006/min | Share of the $12 allowance |
| --- | --- | --- | --- |
| Expected, a few new matches a week | 640 to 680 | About $4 | About a third |
| Worst case with the monthly cap | About 1,490 | About $8.90 | 74% |
| Worst case without the cap | About 2,960 | About $17.80 | 148% |

Actual spend so far is unknown: reading billing use needs a `gh` token with the `user` scope, which this checkout does not have. Other repositories on the same account share the allowance, and their use is also unknown. Check both on GitHub's billing page after the first week.

## Provider limits

### GitHub Actions

| Fact | Value |
| --- | --- |
| Included each month | $12 on Free, $18 on Pro |
| Linux 2-core x64 rate | $0.006/min, so $12 buys about 2,000 minutes |
| When the included amount runs out | Without a payment method, usage is blocked. With one, it is billed |
| Budgets and alerts | Budgets limit overage. Alerts fire at 90% and 100% |
| Artifact storage | 500 MB on Free, 1 GB on Pro, shared with Packages |
| Cache storage | 10 GB per repository, separate from artifacts. Entries unused for 7 days are evicted |
| Private repository `ubuntu-24.04` | 2 vCPU, 8 GB RAM, 14 GB SSD |

The billing page does not say how partial minutes are rounded. If each job rounds up to a whole minute, the 155 scheduled runs below add under 155 minutes.

Schedules run only from the default branch, can be delayed or dropped, and `workflow_dispatch` needs the file on the default branch.

Sources: [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [dependency caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).

### Neon Free

| Limit | Value | Expected use (estimate) |
| --- | --- | --- |
| Storage | 1 GB per project | 12.6 MB measured after crawling and filtering the real catalog (274 jobs, 21 sources) |
| Compute | 100 CU-hours per project per month | About 7 CU-hours at 0.25 CU. About 57 if every active hour ran at the 2 CU ceiling |
| Egress | 5 GB per project per month | Reading the whole 12.6 MB database on all 155 runs would be under 2 GB |
| Autosuspend | After 5 minutes idle, cannot be disabled | Saves compute between runs |
| Instant restore | 6 hours of history | This is the only recovery point. No separate backup is set up |

The compute estimate assumes 53 AI runs of 20 minutes and 102 short runs of about 6.5 minutes, both including the 5-minute idle tail, which is about 29 active hours.

If compute or egress runs out, Neon suspends the compute until the next period. If storage runs out, writes fail and no data is deleted. Source: [Neon plans](https://neon.com/docs/introduction/plans).

### Vercel Hobby

Free, for personal non-commercial use. It includes 4 CPU-hours of Active CPU, 360 GB-hours of provisioned memory, 1,000,000 invocations and 100 GB of transfer. Functions run for up to 300 s. Exceeding a limit usually means waiting until 30 days have passed. An owner-only dashboard for one person should sit far below these, though this is not measured. Source: [Vercel Hobby](https://vercel.com/docs/plans/hobby).

### Telegram

`sendMessage` is limited by rate, not by a plan: about one message per second per chat. The notifier honors `retry_after`. Sources: [sendMessage](https://core.telegram.org/bots/api#sendmessage), [bot FAQ](https://core.telegram.org/bots/faq).

## Measured

### Hosted benchmark

All runs used `ubuntu-24.04` with 2 vCPU and no GPU, one job for a cold cache and one for a cache hit. Each job is one sample of one runner, so these figures show a range, not a distribution.

| Run | Limits | Samples | Job minutes, miss / hit | Warm ok | Median inference, miss / hit | Max inference, miss / hit | Output tokens/s, miss / hit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 41307706600 | Output 500 | 8 short, 1 + 2 passes | 10.2 / 18.0 | 18 of 22 | 53.7 / 54.6 s | 92.1 / 90.0 s | 6.3 |
| 41311909404 | Output 800 | 8 short | 12.4 / 9.9 | 14 of 14 | 78.4 / 55.5 s | 104.1 / 84.4 s | 4.7 / 6.4 |
| 41316782301 | Output 800, timeout 420 s | 8 short, 2 long | 9.5 / 21.2 | 17 of 18 | 30.6 / 97.7 s | 103.9 / 215.9 s | 13 / 4.1 |
| **41320394097** | **Shipped defaults** | **8 short, 2 long** | **16.9 / 19.2** | **18 of 18** | **67.3 / 85.9 s** | **226.7 / 190.5 s** | **6.6 / 4.7** |

The last run is the one the defaults rest on. All 20 attempts, including the two first calls, returned valid JSON with no truncation and no timeouts. Peak container memory was 2486 and 2749 MiB, and available host memory never fell below 4243 MiB. Free disk after start was 6 GiB. Curated data is in `benchmarks/results/`.

The only failure in the third run was long Hebrew hitting the 800-token output limit. The final run used 845 tokens on the same posting, which is why the limit is now 1000.

**Runner speed is the largest uncertainty.** Output speed across these jobs ranged from 4.1 to 13 tokens/s, a threefold spread, on at least four CPU models. Output tokens dominate long-job time. The same sample with the same seed also scored differently across runners (85 and 78 in one case, 15 and 23 in another), so a score near the threshold can flip.

### Other workflows, commit bd45bb3

| Workflow | Job time |
| --- | --- |
| `ci` | 1 min 2 s tests, 1 min 14 s E2E, about 2.3 runner minutes a push |
| `compose-smoke` | 1 min 1 s |
| `pipeline-smoke` | 6 min 21 s, including 207 s scoring 2 real postings |
| `ollama-feasibility` | About 36 runner minutes in total, the sum of both jobs |

Ollama start took 1.1 to 1.7 minutes in the final run: image pull 52 to 98 s, ready in about 1 s, and model download 12 s on a miss. The projection below allows 2 minutes. The download is so short that the model cache saves little.

Real posting lengths (105 postings, estimated tokens): median 1379, 90th percentile 1934, maximum 2652. Longer ones are truncated to the 1600-token input limit.

## Monthly projection (estimated)

Assumes a 31-day month and the Free plan: 124 scheduled runs and 31 maintenance runs.

| Item | Calculation | Minutes |
| --- | --- | --- |
| Discovery with nothing to match | 124 × 1.5 | 186 |
| Maintenance with nothing to match | 31 × 1.5 | 47 |
| CI, manual runs and retries | Allowance, for example 40 pushes (92), 5 compose runs (5), 5 smoke runs (33), 1 benchmark (36), the rest for reruns | 350 |
| **Base** | | **583** |
| AI time at the monthly cap | `AI_MINUTES_PER_MONTH` | 800 |
| Ollama start at the cap | 53 runs × 2, if every AI run spends its full 15 minutes | 106 |
| **Worst case with the cap** | | **About 1,490** |
| Reserve kept free | 2,000 − 1,490 | About 510, or 26% |

The 1.5 minutes for a run without AI is an estimate, because no production run exists. The plan's headroom target was 20%, or 400 minutes.

**Why the cap exists.** Without it, a permanent backlog costs 124 × 18.5 for discovery, 31 × 13.5 for maintenance and 250 for the rest, about 2,960 minutes. That would use up the allowance around day 21, and GitHub would then block discovery along with matching.

**Expected case.** The base 583, plus about 21 eligible jobs a month across 10 AI runs, gives 640 to 680 minutes. The 21 is an assumption of about 5 new eligible postings a week, not a measurement. Only 11 of 377 current jobs pass the filter.

## Volume after catalog growth

Measured on 2026-11-08 against live boards, same filter (`filter-v4`), no model run:

| Catalog | Sources | Israeli jobs | Eligible after filter | Pass rate |
| --- | --- | --- | --- | --- |
| Before (37 sources) | 37 | 454 | 13 | 2.9% |
| After `catalog:discover` (67 sources) | 67 | 596 | 14 | 2.3% |

The catalog grew 1.8x and Israeli jobs 1.3x, but eligible jobs only from 13 to 14: the new companies list few QA roles. So the expected case above barely moves. Scaling the assumed 21 new eligible jobs a month by 14/13 gives about 23 (estimate), still well under the roughly 210 to 250 long postings a month the monthly cap allows.

Model time does not follow the job count in any case. Each run takes at most `MAX_AI_JOBS_PER_RUN` jobs inside `AI_TIME_BUDGET_SECONDS`, and `AI_MINUTES_PER_MONTH` keeps Ollama off once the month is spent, however many jobs are eligible. `AI_QUEUE_LIMIT` (default 40) bounds the backlog: `evaluate` ranks eligible jobs by the deterministic priority and queues only the best 40 runnable tasks that have no answer yet. The rest wait unqueued, shown as pending, and enter as the queue drains. A deeper catalog therefore adds no model calls; it only decides which jobs get them first. `tests/integration/match.test.ts` ("queue limit") checks this with ten times more eligible jobs than the limit.

## Throughput

| Measure | Value |
| --- | --- |
| Time per long posting | 190 to 227 s on the slower runners measured |
| Time per real posting in `pipeline-smoke` | About 103 s |
| Jobs in one 900 s budget | About 3 long on a slow runner, about 6 on a fast one |
| Jobs a month at the cap | About 210 to 250 long postings, more if shorter |

A new job starts only if it can finish by the deadline at the 330 s timeout, so starts stop at 570 s of the 900 s budget.

This is enough for the current 11 eligible jobs, which clear in a day. If more than about 210 jobs a month pass the filter, the backlog grows. `pending` and the status page report the backlog count, and the `health` summary adds the age of the oldest task. Because the queue takes the newest jobs first within a priority, a growing backlog delays the oldest work, so the score of an old posting can arrive after it closes. Discovery continues at six-hour intervals whatever the backlog.

## Controls against paid use

- **Hard stop:** with no payment method on file, GitHub blocks usage at the included amount. With one on file, set a $0 budget for Actions (`DEPLOYMENT.md` step 7 of activation).
- **Monthly cap:** `AI_MINUTES_PER_MONTH` keeps Ollama off once spent. Tasks stay queued and manual runs are blocked too. Set it to 0 to stop AI entirely, or use `pending` to see what remains.
- **Run limits:** `MAX_AI_JOBS_PER_RUN`, `AI_TIME_BUDGET_SECONDS` and per-job limits.
- **Workflow limits:** every job has `timeout-minutes`. Concurrency groups stop overlapping runs.
- **Gate:** `PRODUCTION_ENABLED` must be `true` before either production workflow does anything.
- **Runners:** standard `ubuntu-24.04` only, no larger or self-hosted runners.
- **Expensive checks:** `ollama-feasibility` and `pipeline-smoke` run only when their inputs change on `mvp`, or by hand.
- **No paid AI:** matching uses Ollama on the runner. There is no API key for any model provider.
- **Other providers:** Neon Free and Vercel Hobby stop or wait at their limits. Do not upgrade either without deciding to pay.

## If use runs high

In order:

1. Narrow the profile, so fewer jobs pass the filter.
2. Lower `AI_MINUTES_PER_MONTH`. This is the most direct control.
3. Lower `MAX_AI_JOBS_PER_RUN` or `AI_TIME_BUDGET_SECONDS`.
4. Lower the maintenance AI limit in `.github/workflows/maintenance.yml`.

Discovery runs once a day, with a backup pass in the early afternoon in case GitHub drops the first; maintenance likewise. That is 62 discovery and 62 maintenance runs a month, still fewer than the 155 assumed above, and a backup pass with nothing new costs about 1.5 minutes. The owner gets one message around 09:00 Israel time. This uses fewer minutes than the six-hourly schedule the figures above assume, but jobs that close or open between runs are noticed up to a day late.

Raising `AI_MINUTES_PER_MONTH` trades reserve for throughput. Above about 1,000 the 20% reserve is gone, and more manual runs or a slow month can reach the block. Paid runners, external AI and other infrastructure are outside this design and would need a separate decision.

## Known gaps in these figures

- Runner speed varies, and the sample is a handful of jobs.
- A run killed before it records its finish is not counted against the monthly cap. Workflow timeouts leave room for the stage to finish, so this should be rare.
- A run can start just under the cap and overshoot it by up to one run, 15 minutes.
- Discovery on `master` has no model cache at first, and the cache may be evicted between AI runs. That costs about 12 s to download again.
- Neon may count storage differently from `pg_database_size`, and the measured size has no months of history in it. Retention removes old operational rows after 90 days, and ten times the measured size would still be about 13% of the limit.
