#!/usr/bin/env bash
# Usage: worker.sh <deadline seconds> <worker command> [flags...]
# Runs node directly so the stage deadline signals the worker, not a wrapper.
set -euo pipefail
deadline=$1
shift
exec timeout --kill-after=15 "$deadline" node --import tsx src/worker/cli.ts "$@"
