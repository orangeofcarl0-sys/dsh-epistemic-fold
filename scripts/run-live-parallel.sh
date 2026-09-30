#!/usr/bin/env bash
# Run the live (opt-in) suites against the space-bunny-free route.
#
# ## Why a script rather than a documented command line
#
# Three environment facts must all be right or the run fails in ways that look
# like test failures: the proxy (this machine reaches the provider only through
# a local HTTP proxy), the model route (space-bunny-free is served by OpenCode
# Zen, not by the default ZCode route), and the credential (read from DSH's own
# store so no key is ever copied into this repository or a shell history).
#
# ## The key
#
# It is read at runtime from DSH's credential store and exported only into this
# process tree. It is never printed, never written to a file, and never passed
# as an argument. `set -x` is deliberately NOT used.
#
# Usage:
#   bash scripts/run-live-parallel.sh [replicates] [concurrency] [spec...]
#
# Examples:
#   bash scripts/run-live-parallel.sh 1 6                  # small smoke
#   bash scripts/run-live-parallel.sh 3 8                  # the default sample
#   bash scripts/run-live-parallel.sh 3 8 tests/rc2a-live-real-task.spec.ts

set -euo pipefail

REPLICATES="${1:-1}"
CONCURRENCY="${2:-6}"
shift 2 2>/dev/null || true
SPECS=("$@")
if [ ${#SPECS[@]} -eq 0 ]; then
  SPECS=(tests/rc7d-parallel-long-tasks.spec.ts)
fi

CREDENTIALS="${DSH_CREDENTIALS:-$HOME/.dsh/.credentials.yaml}"
[ -f "$CREDENTIALS" ] || CREDENTIALS="D:/dsh/.credentials.yaml"
[ -f "$CREDENTIALS" ] || { echo "credential store not found" >&2; exit 1; }

# Read ONE value out of the refs block. Never echoed.
KEY=$(python3 - "$CREDENTIALS" <<'PY'
import re, sys
text = open(sys.argv[1], encoding='utf-8').read()
m = re.search(r'^\s+OPENCODE_GO_API_KEY:\s*(\S+)\s*$', text, re.M)
sys.stdout.write(m.group(1) if m else '')
PY
)
[ -n "$KEY" ] || { echo "OPENCODE_GO_API_KEY not present in the credential store" >&2; exit 1; }
echo "live route: opencode.ai/zen/v1 model=space-bunny-free (key len ${#KEY})"

export EF_LIVE=1
export EF_LIVE_BASE_URL="${EF_LIVE_BASE_URL:-https://opencode.ai/zen/v1}"
export EF_LIVE_API_KEY="$KEY"
export EF_LIVE_MODEL="${EF_LIVE_MODEL:-space-bunny-free}"
# Node reaches the provider only through the local proxy. NODE_USE_ENV_PROXY
# makes Node's own fetch honour HTTPS_PROXY, so no adapter change is needed.
export NODE_USE_ENV_PROXY=1
export HTTPS_PROXY="${HTTPS_PROXY:-http://127.0.0.1:10808}"

export EF_TASK_REPLICATES="$REPLICATES"
export EF_TASK_CONCURRENCY="$CONCURRENCY"

echo "replicates=$REPLICATES concurrency=$CONCURRENCY specs=${SPECS[*]}"
exec npx vitest run "${SPECS[@]}"
