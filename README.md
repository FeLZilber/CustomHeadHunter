# CustomHeadHunter

A private job discovery system for one person in Israel. It watches Greenhouse, Lever and Ashby boards, scores shortlisted postings against a profile with a small local model, sends Telegram alerts, and shows everything on an owner-only dashboard.

It needs no always-on computer, paid AI API or self-hosted runner. Scheduled work runs on GitHub Actions, the model runs in Docker on the same runner, and data lives in PostgreSQL.

**Status: deployed for one owner.** A dry-run discovery has passed in production. Real Telegram delivery and scheduled runs are not yet verified. See [PROJECT_STATUS.md](PROJECT_STATUS.md) for what has been verified and [DEPLOYMENT.md](DEPLOYMENT.md) for the remaining operator steps.

## What it does

- Crawls 30 verified company boards once a day, around 09:00 Israel time, using conditional requests where the provider supports them.
- Stores every job before any AI runs, and expires a job only after repeated, complete evidence that it closed.
- Filters deterministically, then matches shortlisted jobs with `qwen2.5:3b` on the runner's CPU, within per-job, per-run and monthly limits.
- Sends each alert once through a database outbox, and holds any delivery it cannot confirm.
- Shows jobs, evidence, saved and applied jobs, profile editing and system health to the configured GitHub account only.
- Lists ready-made searches for sites it does not crawl, such as LinkedIn and Comeet, for the owner to open by hand.

You can mark a job "not relevant" with a reason, from the list or the job page. It leaves the main lists and appears on the Dismissed page, which counts reasons and repeated companies. The Filtered out page shows what the rule filter removed and why, so a wrongly rejected job can be flagged. You can mark a job as applied for on its page. The Applied page lists those jobs. Tracking goes no further than that: interview stages and notes, like further ATS connectors, are roadmap items and are not part of this MVP.

## Quick start

With Docker:

```sh
cp .env.example .env
docker compose up -d
docker compose run --rm worker migrate
docker compose run --rm worker seed
```

The dashboard is at <http://localhost:3000>. It needs `NEXTAUTH_SECRET`, `GITHUB_ID`, `GITHUB_SECRET` and `OWNER_GITHUB_ID` in `.env`. Use a GitHub OAuth app with the callback `http://localhost:3000/api/auth/callback/github`.

Migrations are always an explicit step. The dashboard never applies them.

Without Docker, use Node 24 and any PostgreSQL 18 database:

```sh
npm ci
cp .env.example .env    # set DATABASE_URL
npm run worker -- migrate
npm run worker -- seed
npm run dev
```

## Running the worker

Each command runs once and exits. With Docker, replace `npm run worker --` with `docker compose run --rm worker`.

```sh
npm run worker -- crawl --dry-run       # fetch and normalize, write nothing
npm run worker -- crawl                 # discover jobs
npm run worker -- evaluate              # filter and queue AI tasks
npm run worker -- pending               # count runnable tasks
npm run worker -- match --trigger manual
npm run worker -- notify --dry-run      # show what would be sent
npm run worker -- health
```

`DRY_RUN=true` applies dry run to `crawl`, `match` and `notify`.

### Local model

```sh
docker compose --profile ollama up -d ollama
docker compose --profile ollama exec ollama ollama pull qwen2.5:3b
docker compose run --rm worker match --trigger manual
```

Ollama listens on the Compose network only and is not published to the host. The pulled digest must match [ollama/model-lock.json](ollama/model-lock.json), or `match` refuses to run.

### Working without a model

Skip `match`. Tasks stay pending, and the dashboard labels those jobs as pending, so nothing invented is shown. For scored data, `tests/e2e/seed.ts` runs the real pipeline with a scripted model against a test database. Keep that data out of production.

## Adding companies

```sh
npm run catalog:add -- "Company Name" --industry fintech --dry-run
npm run catalog:add -- --file candidates.txt --industry technology
```

The script guesses the company's board slug on Greenhouse, Lever and Ashby, and adds it to [catalog/sources.json](catalog/sources.json) only if the board answers and lists at least one Israeli job. Use `--provider` and `--key` when you know the slug. Candidate names can come from any public directory, such as Dealroom's Israel startup list. Companies that use Comeet or other boards report `no public board found`.

## Documentation

| File | Covers |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Data flow, lifecycle, queue and outbox guarantees, trade-offs |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Neon, Telegram, GitHub OAuth, Vercel, secrets, activation |
| [OPERATIONS.md](OPERATIONS.md) | Workflows, manual inputs, runbook |
| [OLLAMA_SETUP.md](OLLAMA_SETUP.md) | Model pinning, cache, limits, benchmarking |
| [TESTING.md](TESTING.md) | Test commands, live checks, results |
| [COSTS.md](COSTS.md) | Measured use, projections, free-tier limits |
| [PROJECT_STATUS.md](PROJECT_STATUS.md) | Progress, blocked checks, next steps |
