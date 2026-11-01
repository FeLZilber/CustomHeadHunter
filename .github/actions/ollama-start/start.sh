#!/usr/bin/env bash
# Starts Ollama on loopback and verifies the locked model. Writes timings to
# $RUNNER_TEMP/ollama-start.json for run summaries and benchmarks.
set -euo pipefail

models_dir="$GITHUB_WORKSPACE/.ollama-models"
base_url="http://127.0.0.1:11434"
mkdir -p "$models_dir"

now_ms() { date +%s%3N; }

installed_digest() {
  curl -fsS "$base_url/api/tags" |
    jq -r --arg model "$OLLAMA_LOCKED_MODEL" '.models[] | select(.name == $model) | .digest'
}

disk_before_gib=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)

started=$(now_ms)
timeout 300 docker pull --quiet "$OLLAMA_IMAGE" >/dev/null
image_pull_ms=$(($(now_ms) - started))

started=$(now_ms)
docker run -d --name ollama \
  -v "$models_dir:/root/.ollama/models" \
  -p 127.0.0.1:11434:11434 \
  -e OLLAMA_NUM_PARALLEL=1 \
  -e OLLAMA_MAX_LOADED_MODELS=1 \
  -e OLLAMA_KEEP_ALIVE=30m \
  "$OLLAMA_IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if curl -fsS "$base_url/api/version" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ -z "${ready:-}" ]]; then
  echo "::error::Ollama was not ready within 60 seconds"
  docker logs --tail 50 ollama
  exit 1
fi
container_ready_ms=$(($(now_ms) - started))

model_pull_ms=0
digest=$(installed_digest)
if [[ -z "$digest" ]]; then
  started=$(now_ms)
  timeout 600 docker exec ollama ollama pull "$OLLAMA_LOCKED_MODEL"
  model_pull_ms=$(($(now_ms) - started))
  digest=$(installed_digest)
fi

if [[ "$digest" != "$OLLAMA_LOCKED_DIGEST" ]]; then
  echo "::error::Model digest $digest does not match the lock $OLLAMA_LOCKED_DIGEST. See OLLAMA_SETUP.md for the refresh procedure."
  exit 1
fi

# The container writes as root; the cache action tars as the runner user.
sudo chown -R "$(id -u):$(id -g)" "$models_dir"

jq -n \
  --argjson imagePullMs "$image_pull_ms" \
  --argjson containerReadyMs "$container_ready_ms" \
  --argjson modelPullMs "$model_pull_ms" \
  --argjson modelCacheBytes "$(du -sb "$models_dir" | cut -f1)" \
  --argjson imageBytes "$(docker image inspect "$OLLAMA_IMAGE" --format '{{.Size}}')" \
  --argjson diskBeforeGiB "$disk_before_gib" \
  --argjson diskAfterGiB "$(df -BG --output=avail / | tail -1 | tr -dc 0-9)" \
  --arg digest "$digest" \
  --arg image "$OLLAMA_IMAGE" \
  '$ARGS.named' >"$RUNNER_TEMP/ollama-start.json"
cat "$RUNNER_TEMP/ollama-start.json"
