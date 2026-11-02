# Deployment

Steps 1 to 6 were done for this project on 2026-11-02, and a dry-run discovery passed. This guide still describes how to repeat them. Each step is an operator action, and a step that was not run must not be reported as working. Provider facts were checked on 2026-11-01. See `COSTS.md` for limits.

Follow the order below, because each step needs the one before.

## 1. Repository

Keep the repository private. Environments and environment secrets are not available on private repositories on GitHub Free, so this project uses repository secrets ([docs](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)).

CI runs on pull requests without secrets. Do not pass production secrets to any workflow triggered by a pull request.

## 2. Database (Neon Free)

1. Create a project at [neon.com](https://neon.com). New projects default to Postgres 18, the version the tests use.
2. Copy both connection strings from the Connect dialog: the pooled one, whose host contains `-pooler`, and the direct one. Both need `sslmode=require`.
3. Apply migrations and seed the catalog through the direct connection, from a checkout of `master`:

   ```sh
   DATABASE_URL='<direct string>' npm run worker -- migrate
   DATABASE_URL='<direct string>' npm run worker -- seed
   ```

Everything else uses the pooled string, including the `migrate` step in each pipeline run. Migrations are explicit and never run at dashboard startup. `DATABASE_MIGRATION_URL` is not needed, because each migration runs in one transaction under a transaction-scoped lock, which Neon's transaction-mode pooler supports ([docs](https://neon.com/docs/connect/connection-pooling)). This has been tested on plain Postgres only, so use the direct string if a pooled migration fails.

Use a separate database for tests. Never point `TEST_DATABASE_URL` at production: test setup truncates tables.

## 3. Telegram

1. In Telegram, message [@BotFather](https://t.me/botfather), send `/newbot` and copy the token. The token is a password.
2. Send your new bot any message.
3. Find the chat id. The URL contains the token, so do not paste this command or its output anywhere:

   ```sh
   curl -s "https://api.telegram.org/bot<token>/getUpdates" | jq '.result[].message.chat.id'
   ```

Without these values discovery still runs and events stay pending, so this step can wait.

## 4. GitHub OAuth app

Create one at GitHub Settings → Developer settings → OAuth Apps. The callback URL comes from step 5. If you do not know it yet, use a placeholder and return here.

- Homepage URL: `https://<project>.vercel.app`
- Callback URL: `https://<project>.vercel.app/api/auth/callback/github`

Keep the client id and generate a client secret. Then find the owner's numeric id:

```sh
gh api users/<login> --jq .id
```

## 5. Dashboard (Vercel Hobby)

Hobby is for personal, non-commercial use. Import the repository at [vercel.com/new](https://vercel.com/new). `vercel.json` pins the framework to Next.js. Without it, a wrong Framework Preset failed the first deploys on 2026-11-02 (`STATIC_BUILD_NO_OUT_DIR` for "Other", "No entrypoint found" for a Node preset), each after a good build. The framework is normally detected and `engines` in `package.json` selects Node 24, which matters because Vercel's default is 26. Set the production branch to `master`, and set these variables for Production only:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Neon pooled string |
| `NEXTAUTH_URL` | `https://<project>.vercel.app` |
| `NEXTAUTH_SECRET` | `openssl rand -base64 32` |
| `GITHUB_ID`, `GITHUB_SECRET` | From step 4 |
| `OWNER_GITHUB_ID` | Numeric id from step 4 |

Do not create a `NEXT_PUBLIC_` variable, because those reach the browser. Leave Preview and Development variables empty so that preview deployments cannot read production data.

## 6. Actions secrets and variables

Repository Settings → Secrets and variables → Actions.

| Secret | Value |
| --- | --- |
| `DATABASE_URL` | Neon pooled string |
| `TELEGRAM_BOT_TOKEN` | From step 3 |
| `TELEGRAM_CHAT_ID` | From step 3 |

Optional variables override defaults and are listed in `OPERATIONS.md`. Set `PRODUCTION_ENABLED` to `true` only at step 8.

## 7. Merge to master

Scheduled workflows run only from the default branch, and manual dispatch needs the workflow file on it. Merge `mvp` into `master` by pull request. The model cache saved on `mvp` is not visible to `master`, so the first AI run there downloads the model, which took 10 to 13 s on hosted runners.

## 8. Activation checks

Work through these in order, and stop at the first failure.

1. Open the dashboard. A non-owner account must land on the denied page, and the owner must see an empty job list.
2. Edit the profile on the dashboard before any AI work runs, because a later edit rematches everything.
3. Set the repository variable `PRODUCTION_ENABLED` to `true`.
4. Run `discovery` by hand with `notify-dry-run` on. Expect a green run, 21 sources and about 270 active jobs. The figure was 272 on 2026-11-01 and will drift. Matching runs for real; only sending is skipped.
5. Run `discovery` without dry run, then confirm the baseline digest arrives in Telegram.
6. Check the next scheduled run at `17 6 * * *` UTC (08:17 in Israeli winter time, 09:17 in summer time), and `maintenance` at `17 7 * * *` UTC.
7. In GitHub billing, set a $0 budget for Actions overage if a payment method is on file. Check actual use after the first week and compare it with `COSTS.md`.

Only after these pass is it true to call the system deployed.

## Rollback

Set `PRODUCTION_ENABLED` to `false`, which stops every scheduled run on its first condition. Job data stays in Neon. Migrations are forward-only, so create a Neon branch before applying a new one.
