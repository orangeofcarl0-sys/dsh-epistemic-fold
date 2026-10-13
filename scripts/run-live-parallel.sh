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

# This script's own directory, via `dirname` rather than `${BASH_SOURCE[0]%/*}`:
# the parameter expansion cannot strip a backslash path. See run-tau2.sh.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The shared credential read and route exports, one implementation for every route
# launcher.
. "${SCRIPT_DIR}/live-env.sh"

REPLICATES="${1:-1}"
CONCURRENCY="${2:-6}"
shift 2 2>/dev/null || true
SPECS=("$@")
if [ ${#SPECS[@]} -eq 0 ]; then
  SPECS=(tests/rc7d-parallel-long-tasks.spec.ts)
fi

# The credential store. Override with DSH_CREDENTIALS, or let it default to the
# standard DSH home. Deliberately NO machine-specific fallback: a hardcoded path
# would only work on the machine it was written on, and this file ships inside a
# published package.
CREDENTIALS="${DSH_CREDENTIALS:-$HOME/.dsh/.credentials.yaml}"
[ -f "$CREDENTIALS" ] || {
  echo "credential store not found at $CREDENTIALS" >&2
  echo "set DSH_CREDENTIALS to its path" >&2
  exit 1
}

# Read ONE value out of the refs block. Never echoed. The read itself is
# scripts/live-env.sh's ef_read_key, shared with the other route launchers.
KEY=$(ef_read_key python3 "$CREDENTIALS")
[ -n "$KEY" ] || { echo "OPENCODE_GO_API_KEY not present in the credential store" >&2; exit 1; }
echo "live route: opencode.ai/zen/v1 model=space-bunny-free (key len ${#KEY})"

export EF_LIVE=1
# The route exports are shared; this lane's base URL and model are its defaults.
ef_export_route "$KEY" "https://opencode.ai/zen/v1" "space-bunny-free"
# Node reaches the provider only through the local proxy. NODE_USE_ENV_PROXY
# makes Node's own fetch honour HTTPS_PROXY, so no adapter change is needed.
export NODE_USE_ENV_PROXY=1
export HTTPS_PROXY="${HTTPS_PROXY:-http://127.0.0.1:10808}"

export EF_TASK_REPLICATES="$REPLICATES"
export EF_TASK_CONCURRENCY="$CONCURRENCY"

echo "replicates=$REPLICATES concurrency=$CONCURRENCY specs=${SPECS[*]}"
exec npx vitest run "${SPECS[@]}"
