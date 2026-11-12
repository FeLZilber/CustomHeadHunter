# Project status

Resume document. Update after every milestone and any decision a new session could not re-derive.

- **Plan:** `Personal_Job_Hunter_Claude_Prompt.txt` in the repo root (gitignored, operator's local brief). Sections 18 (tests) and 21 (final report) define done.
- **Branch:** `master`, the default branch. `search-recall` merged 2026-11-02. Scheduled and dispatch workflows only operate once they reach `master`.
- **State:** Deployed 2026-11-02. The dashboard is live at the Vercel deployment and the owner signed in. A manual dry-run discovery on `master` passed against Neon (run 41432026270). `PRODUCTION_ENABLED` is `true` (set 2026-11-04). **Not yet verified:** a real Telegram delivery and refusal of a second GitHub account.
- **Scheduled runs: none has ever happened (checked 2026-11-08).** `gh run list --event schedule` returned nothing for any workflow, while push and workflow_dispatch runs worked (discovery dispatched 2026-11-04 twice and 2026-11-08 once, all green). The repository was created 2026-11-04 by pushing existing history and `master` was then force-pushed twice, so no push to this repository ever changed a workflow's `schedule`. The evidence points to the schedule never being registered. Ruled out: workflows disabled (both `active`), Actions settings (enabled, all actions allowed), the `PRODUCTION_ENABLED` gate and the concurrency group (both would still show runs, as skipped or cancelled), the 60-day inactivity rule (the repository is 4 days old), visibility (public), and best-effort dropping (8 of 8 slots missed, not a sporadic pattern). Both workflows were disabled and re-enabled at 2026-11-08 11:32 UTC to re-register them, and `ops/scheduled-runs` changes their schedules, which registers them again on merge. Each now has a backup cron (discovery 06:17 and 11:43, maintenance 07:17 and 13:43 UTC). **A scheduled run is still not verified:** confirm with `gh run list --event schedule` after the next cron time, and record the run id here.
- **Last updated:** 2026-11-12

## Milestones

| Milestone | State |
| --- | --- |
| M0 Feasibility | Done. Final hosted run 41320394097 with the shipped defaults: 20 of 20 attempts valid. See `COSTS.md`. |
| M1 Durable ingestion | Done. Live-tested against real boards, and run on Neon through the pooled string on 2026-11-02. |
| M2 Bounded AI | Done. Live-tested on local GPU and on a hosted runner (`pipeline-smoke`, 2 real postings), and in production on 2026-11-02: 4 scored, 0 failures. |
| M3 Notifications and automation | Done. Hosted CI and pipeline smoke green. Real Telegram delivery not tested: no bot exists. Schedules not active: they need `master` and secrets. |
| M4 Private dashboard and dev setup | Done. 29 E2E tests (applied tracking added after the hosted run below), CI 41320412960 and `compose-smoke` 41320413027 green at bd45bb3. Deployed to Vercel 2026-11-02 and the owner signed in with GitHub. A stranger's sign-in was not tested. |
| M5 MVP hardening and handover | Done as far as access allows: docs written, failure tests complete, monthly cap added, benchmark and costs recorded. Live checks below remain blocked. |

## Acceptance

Plan section 21. "Blocked" means it needs an operator account or action. A mocked check does not count as live.

| # | Behavior | Implemented | Fixture-tested | Live-tested | Deployed |
| --- | --- | --- | --- | --- | --- |
| 1 | Greenhouse, Lever and Ashby discovery, identity and links | Yes | Yes | Yes, 30 sources, 377 jobs, throwaway database | Blocked |
| 2 | Postgres persists before AI, no duplicates on repeat | Yes | Yes | Yes, throwaway Postgres | Blocked |
| 3 | Incremental avoids needless matching, full snapshots handled | Yes | Yes | Yes, second crawl all `not_modified` | Blocked |
| 4 | Partial or failed crawls never expire jobs, grace and reopening | Yes | Yes | Not exercised: no real closure or failure seen live | Blocked |
| 5 | Ollama in Docker on a hosted runner, within limits | Yes | Yes | Yes, runs 41320394097 and 41320412962 | Blocked |
| 6 | AI output validated, failures leave jobs and tasks intact | Yes | Yes | Valid output live. Failure paths fixture-only | Blocked |
| 7 | Matching-relevant changes invalidate stale results | Yes | Yes | No | Blocked |
| 8 | Telegram delivery, outbox retry and ambiguity | Yes | Yes | **Blocked: no bot** | Blocked |
| 9 | Scheduled and manual workflows, bounded maintenance | Yes | Yes | Shared pipeline passed in smoke. Manual dispatch on `master` green 3 times. **No scheduled run has ever fired** (see State). Staleness drill: see `ops/scheduled-runs` PR | Manual runs only |
| 10 | Owner-only dashboard | Yes | Yes, E2E with signed test sessions Owner sign-in worked on the Vercel deployment (2026-11-02). Stranger refusal not tested live | Yes, dashboard only. Workers not active |
| 11 | Automated tests pass, setup reproducible | Yes | 407 + 33 pass | CI green. Compose built on a runner, and run locally with Ollama from a fresh clone | n/a |
| 12 | No always-on PC, self-hosted runner, VPS or paid AI API | Yes | n/a | Holds by construction | Blocked |

## Blocked checks

| Check | Needs |
| --- | --- |
| Neon, including the pooler | A Neon project |
| Real Telegram delivery | A bot and chat id |
| Sign-in refusal of a second GitHub account | A second account |
| Vercel deployment | A Vercel project |
| Scheduled runs | A schedule run to appear after re-registration (2026-11-08) |
| Actual Actions spend | Billing page, or a `gh` token with the `user` scope |
| Evaluation labels | A person to review them |

## Next operational steps

Everything left needs the operator's accounts. Tick these off here as they happen. Details are in `DEPLOYMENT.md`.

- [x] Create a Neon project: `headhunter` (`proud-glade-09445629`), org `org-raspy-cake-67592538`, `aws-eu-central-1`, Postgres 18, created 2026-11-02. The org is on the Free plan. Fetch the direct and pooled connection strings from the Neon console or `neon connection-string`, and keep them out of the repo. Schema not migrated yet.
- [x] Create a Telegram bot with @BotFather and find the chat id. Bot and chat exist (private chat, id `9228977584`). A real message has not been sent by the app yet.
- [x] Create a GitHub OAuth app and look up the owner's numeric GitHub id (from the GitHub profile API). Done 2026-11-02.
- [x] Create a Vercel Hobby project (the Vercel deployment, production branch `master`) and set the dashboard variables. Done 2026-11-02. `vercel.json` pins the framework (PR #2, merged 2026-11-02).
- [ ] Add the repository secrets. `DATABASE_URL` (pooled) and `TELEGRAM_CHAT_ID` are set, 2026-11-02. `TELEGRAM_BOT_TOKEN` was set by the owner the same day. All three exist, and none has been used by a real run yet.
- [x] Run `migrate` once against Neon through the direct connection string. Done 2026-11-02: migrations 0001 to 0005 applied, 21 sources seeded. The pooler is still untested.
- [x] Merge `search-recall` into `master`. Done 2026-11-02.
- [ ] After the next pipeline run, which applies migration 0006, seeds the 30 sources and re-evaluates under `filter-v2`, confirm in production: the eligible count, no pending tasks for rejected jobs, and no crawl failures on the nine new sources.
- [x] Merge pull request #1 (`mvp` into `master`). Done 2026-11-02.
- [ ] Run the activation checks in order: dashboard as owner and as a stranger, edit the profile, set `PRODUCTION_ENABLED`, dry-run discovery, real discovery, first Telegram digest, scheduled run.
- [ ] Set a $0 Actions budget if a payment method is on file. Compare real use with `COSTS.md` after a week.
- [ ] Review the labels in `benchmarks/eval/dataset.json`. Until then quality is unconfirmed.
- [x] Verify more company sources. 2026-11-08: 781 candidate names probed with `catalog:discover`, 30 added (67 total). See Known limitations.

## Known limitations

**Applied tracking**

- It records only that and when the owner applied. Interview stages, notes and follow-up dates are not built.
- An applied job can still produce an alert if it changes or reopens.

**Product**

- **Workday sources, 2026-11-12 (branch `ingest/workday`, not merged).** A live crawl of the 67-source catalog held 586 Israeli jobs and `filter-v4` kept 10, of which 3 were QA or automation roles; only one rejected title looked test-related, so the filter was not the limit. A Workday connector and 27 verified Workday career sites (NVIDIA 408 Israeli jobs, Applied Materials 83, KLA 81, Cisco 48, Medtronic 32 and others) bring the catalog to 94 sources and 1,397 Israeli jobs. `filter-v5` adds a `hardware_discipline` rejection (246 jobs) and keeps 104, 13 of them with a QA title. The crawl took 211 s of its 300 s budget, 93 of 94 snapshots complete. With 104 eligible jobs and `AI_QUEUE_LIMIT` 40, the model now works through a backlog at 8 jobs a run. Not verified: a production run, and any model score for a Workday job.
- **Target-role recall is the main risk.** On 2026-11-08 the 67-source catalog held 596 Israeli jobs (454 with the previous 37 sources the same day), and `filter-v4` kept 14 (13 before). More companies add few QA roles. On 2026-11-02 the catalog held 377 Israeli jobs, and `filter-v2` kept 11. Six have test or automation titles (three at Island, one at Navan, two at Cato, one of those for network automation). Five are not QA roles. This is catalog coverage, not a filter bug: these boards list few Israeli QA jobs. Do not pad the catalog with unverified sources. New ATS connectors are roadmap work and need separate authorization.
- **Comeet is the largest known gap, and it is deliberately not crawled.** It holds most of the Israeli QA roles found: about 11 software QA titles among 383 Israeli jobs on the boards sampled, 2026-11-02. It has no public feed, so crawling means parsing hosted pages. [Spark Hire's job-seeker terms](https://www.sparkhire.com/terms/job-seeker) ban scraping but do not name Comeet, and Comeet's own terms pages returned 403 and are unread. The owner reaches it by hand through the `/search` page.
- **AllJobs and Drushim are not crawled, checked 2026-11-02.** Drushim's `robots.txt` and sitemap allow access, but [its terms](https://www.drushim.co.il/article/2/) ban collecting information with automated software and limit use to personal job applications. AllJobs answers non-browser requests with a Radware block page and CAPTCHA, and [its terms](https://www.alljobs.co.il/UserAgreement.aspx) ban copying content without written permission. Both stay on the `/search` page.
- **Other sources checked 2026-11-12, none added.** A Workable probe of `catalog/candidates.txt` found no board with Israeli jobs in 86 answered names before the rate limit stopped it. SmartRecruiters' API `robots.txt` still disallows every agent but LinkedInBot. Comeet's `robots.txt` allows its job pages, but the terms question above is unchanged. Drushim, AllJobs and LinkedIn are unchanged. SecretHunter (secrethunter.io) is the most promising untried source: about 30,000 Israeli jobs, 658 with a QA-like title in its sitemap, and a `robots.txt` that allows crawlers. Its job pages are rendered in the browser from `api.secrethunter.io`, an undocumented API, and no terms page could be read, so it needs the owner's decision and probably the site's permission.
- **Catalog gap:** 67 sources (47 Greenhouse, 4 Lever, 16 Ashby) after the 2026-11-08 discovery run, few banks or government employers. Of 781 candidate Israeli companies, 30 new ones had a Greenhouse, Lever or Ashby board with a job at a named Israeli location; 663 had no board found under any guessed slug and 55 had a board with no Israeli job. Nine more boards were rejected because their only "Israeli" jobs were remote-anywhere (e.g. a US company's board). The target of 150 sources is not reachable from these three providers: most Israeli employers use Comeet or their own sites.
- **Human calibration is outstanding.** Evaluation labels are machine-proposed, so results measure agreement with a draft, not quality.
- **Evidence is weak,** especially in Hebrew: about a third of quotes are literal on hosted runs. Evidence is stored and shown as verified or not.
- **Scores vary across runners.** Same seed, 85 and 78 in one case, 15 and 23 in another, so a score near the threshold can flip.
- **Adjacent roles are display-only.** They get no score and no alert, by design. The tier is a title match on role-only rejections, so a near role whose title lacks a listed term stays an ordinary filtered job until the owner adds the term. The adjacent view reads at most 5000 rejected jobs and pages them in memory.

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

- **Model judges, code does arithmetic.** The model returns no points. Code scores skills, experience, seniority, location and industry from extracted facts (`rubric-v2`), and the model's role category sets the role points. Documented in `ARCHITECTURE.md`.
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

## Resuming on a new machine

Everything except the items below is in GitHub (code, docs, history), Neon (data), and GitHub or Vercel (secrets, variables).

1. Clone the repository, check out `mvp`, run `nvm use` (Node 24) and `npm ci`.
2. Copy back `Personal_Job_Hunter_Claude_Prompt.txt` (gitignored, the original plan) from your own backup into the repo root.
3. Log in again: `gh auth login` , `neon login`, `npx vercel login` then `npx vercel link`.
4. Set `git config user.email` to the GitHub no-reply address. Do not use the work address.
5. Optional, to rebuild the Neon skill and MCP: `neon skills -s neon --agent claude-code -y` and `neon mcp --oauth --project --agent claude-code -y`. They are not committed.
6. Not recoverable from GitHub or Vercel, because secrets cannot be read back: the Telegram bot token (BotFather `/mybots` shows it again) and the GitHub OAuth client secret (generate a new one and update `GITHUB_SECRET` in Vercel).

## Things not to forget

- `NEXTAUTH_URL` must match the deployment URL.
- A hosted benchmark costs about 36 runner minutes and leaves a `-spike-` cache to delete.
- Neon, the Telegram bot, the OAuth app, the Vercel project and the three Actions secrets now exist. Manual discovery runs have used them since 2026-11-04 and `PRODUCTION_ENABLED` is `true`, but no scheduled run has happened yet, and no real Telegram message has been sent. Do not claim otherwise.
- Do not merge to `master` without the operator: that is step 7 of `DEPLOYMENT.md`.
