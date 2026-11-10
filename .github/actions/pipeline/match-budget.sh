#!/usr/bin/env bash
# Usage: match-budget.sh <match deadline, epoch seconds> <AI time budget seconds> <seconds to set aside first>
# Prints "<AI time budget> <stage deadline>": the budget trimmed so matching ends
# before the deadline, after setting the given seconds aside (for Ollama's start),
# and the deadline for the match stage. Prints "0 0" when the time left
# cannot fit one inference. NOW overrides the clock for tests.
set -euo pipefail

deadline=$1
ai_seconds=$2
set_aside=$3
inference=${INFERENCE_TIMEOUT_SECONDS:-330}
now=${NOW:-$(date +%s)}

left=$(( deadline - now - set_aside ))
# The worker needs time to start, record the run and exit after its budget.
budget=$(( left - 60 ))
if (( budget > ai_seconds )); then budget=$ai_seconds; fi
# The runner starts no inference that cannot finish inside the budget.
if (( budget < inference )); then
  echo "0 0"
  exit 0
fi

stage=$(( budget + inference + 60 ))
if (( stage > left )); then stage=$left; fi
echo "$budget $stage"
