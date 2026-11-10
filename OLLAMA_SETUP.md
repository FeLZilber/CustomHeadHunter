# Ollama setup

Matching runs Ollama in the official Docker container on a GitHub-hosted runner, on CPU, for the length of one job. Nothing stays running between jobs. Model files are never committed, and Ollama is never exposed publicly. Official docs: [Ollama in Docker](https://docs.ollama.com/docker), [structured outputs](https://docs.ollama.com/capabilities/structured-outputs).

## What is pinned

`ollama/model-lock.json` is the single source for Actions and the worker:

| Field | Value |
| --- | --- |
| `model` | `qwen2.5:3b` |
| `modelDigest` | `357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b` |
| `ollamaImage` | `ollama/ollama:0.40.13@sha256:b2f0122c476bc9fe7ce679d8bb4bd555351e25e2554eefb156f61cb0a89cf429` |
| `cacheRevision` | `1` |

`docker-compose.yml` repeats the image, so change both together.

The model is 1,929,912,432 bytes and the image about 5 GB. A hosted run peaked at 2749 MiB of container memory.

## On Actions

`.github/actions/ollama-start` does the following, and the pipeline calls it only when `pending` reports runnable work:

1. Restores `.ollama-models` from the Actions cache.
2. Pulls the pinned image, with a 300 s limit.
3. Starts the container bound to `127.0.0.1:11434`, with one parallel request and one loaded model.
4. Pulls the model if it is not there, with a 600 s limit.
5. Compares the installed digest with the lock and stops on any difference.
6. Saves the cache on a miss, before any inference, so a later failure cannot lose the download.

`match` checks the digest again, and the container is removed at the end of the run.

The model runs with `temperature` 0, `seed` 42, and the response schema passed as `format`. It has no tools, secrets or network access, and posting text is treated as untrusted data.

Measured on 2026-11-01 in run 41320394097: image pull 52 and 98 s, ready in about 1 s, model download 12 s, free disk about 6 GiB after start.

## Cache

The key is `ollama-<os>-<arch>-rev<cacheRevision>-<digest>`. Benchmarks add a `-spike-<run>-<attempt>` suffix, which forces a miss.

- **Immutable:** a key cannot be overwritten. To replace a broken entry, raise `cacheRevision`.
- **Scope:** a run reads caches from its own branch and the default branch. The cache from `mvp` is not visible on `master`, so the first AI run on `master` downloads the model.
- **Eviction:** entries unused for 7 days are removed, and the total limit is 10 GB. The next AI run downloads the model again.
- **Value:** the download took 10 to 13 s in the hosted runs. A miss is cheap, so a missing cache is not a problem to fix.
- **Cleanup:** benchmarks leave `-spike-` entries. Delete them afterwards with `gh cache list` and `gh cache delete <id>`.

Source: [dependency caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).

## Input limits

| Limit | Default | Why |
| --- | --- | --- |
| `MAX_JOB_INPUT_TOKENS` | 1600 | Real postings: median 1379, 90th percentile 1934. Longer ones keep the opening and the requirements section |
| `MAX_OUTPUT_TOKENS` | 1000 | 500 cut off Hebrew answers. 800 cut off long Hebrew. The longest measured answer used 845 |
| `OLLAMA_NUM_CTX` | 3200 | Input + 600 prompt overhead + output must fit, or `buildMatchConfig` refuses to start |
| `INFERENCE_TIMEOUT_SECONDS` | 330 | Slowest measured call was 226.7 s |
| `MAX_AI_JOBS_PER_RUN` | 8 | With the time budget, bounds one run |
| `AI_TIME_BUDGET_SECONDS` | 900 | A job starts only if it can finish by this deadline |
| `AI_MINUTES_PER_MONTH` | 800 | See `COSTS.md` |

The context guard exists because Ollama silently drops the start of an overflowing prompt, which is where the instructions are.

Token counts here are estimates by the app, and they err high on truncated input. The system prompt and profile take about 510 tokens.

The workflows pass on only the variables they list. `MAX_OUTPUT_TOKENS` and `OLLAMA_NUM_CTX` are not among them, so changing either on Actions means editing `src/config/budget.ts`.

The model, digest, prompt, schema, rubric, inference options and input limit all form the match config hash. Changing any of them invalidates every stored result, and the eligible set is rematched over later runs. Workflow budgets and job counts are not part of it.

## Local use

With Ollama installed on the machine:

```sh
ollama pull qwen2.5:3b
npm run worker -- match --trigger manual
```

With Compose, see the local model section of `README.md`. Give the Docker VM at least 4 GB of memory: Ollama held 2.8 GiB after 8 jobs. A local run is useful for development, but it shows nothing about hosted performance. The local GPU run did not show the Hebrew cut-offs found on hosted runners.

## Benchmarking

Local:

```sh
npx tsx benchmarks/ollama/run.ts --label local --passes 1
```

Hosted: run `ollama-feasibility` by hand, or push a change to its inputs on `master`. It costs about 36 runner minutes, and uses a cold cache in one job and a cache hit in the next. Download the artifacts, then:

1. Curate `result.json` and `ollama-start.json` into `benchmarks/results/`, with model outputs removed.
2. Check that the run's `delete-cache` job removed its `-spike-` cache entries.
3. Update `COSTS.md`, and any default the result changes.

`benchmarks/ollama/samples.json` holds 8 short synthetic postings and 2 at the input limit, in English, Hebrew and both. One carries embedded instructions. The full list of runs is in `COSTS.md`. Label the environment and sample size when quoting a result, and do not present a local figure as a hosted one.

`benchmarks/eval` measures agreement with draft labels. See `TESTING.md`.

## Changing the model or image

1. Pull the new model locally and read its digest from `curl -s localhost:11434/api/tags`.
2. Update `ollama/model-lock.json`, and `docker-compose.yml` for an image change. Read an image digest with `docker buildx imagetools inspect <image>`.
3. Run the evaluation set locally, then the hosted benchmark with the same limits.
4. Check the measured time, truncation and memory against the limits above.
5. Update this file and `COSTS.md`.

Expect a full rematch, because a new digest changes the match config hash. That can take several runs, and it spends the monthly cap.

`OLLAMA_MODEL` and `OLLAMA_MODEL_DIGEST` override the lock for a one-off local test, and a model other than the locked one needs both. `.github/actions/ollama-start` always uses the lock.

## Failure behavior

Jobs and tasks stay intact in every case, and no score is invented.

| Failure | What happens | Next step |
| --- | --- | --- |
| Image or model pull fails, or container not ready in 60 s | Ollama step fails. Crawl and notify still run, and the job is red | Usually transient. The next run tries again |
| Digest differs from the lock | Nothing runs (`digest_mismatch`) | Upstream changed or the lock is wrong. Follow the steps above |
| Ollama unavailable during a run | The claim is released with no attempt spent, and the stage stops | Next run retries |
| HTTP error from Ollama | One attempt is spent and the stage stops | Bounded retries, then the task fails |
| One job times out | One attempt is spent, and the stage continues | Bounded retries |
| Invalid JSON or schema | One more call with the validation errors if time remains, then an attempt is spent | Bounded retries |
| Output cut off at the limit | One more call asking for a shorter reply if time remains, then an attempt is spent. A partial answer is never used | Check `MAX_OUTPUT_TOKENS` |
| Budget or job cap reached | The stage stops. Finished work is already saved | Remaining tasks wait for the next run |
| Monthly cap reached | Ollama does not start | Tasks wait for next month |

The stop reason is stored in `match_runs`, and the status page shows the latest run. See `OPERATIONS.md` for the runbook.
