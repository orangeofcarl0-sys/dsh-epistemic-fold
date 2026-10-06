#!/usr/bin/env bash
# Run the tau2-Bench-Verified integration against the space-bunny-free route.
#
# ## Why a script rather than a documented command line
#
# Four environment facts must all be right or the run fails in ways that look
# like benchmark failures: the proxy (this machine reaches the provider only
# through a local HTTP proxy), the route (space-bunny-free is served by OpenCode
# Zen, not by the default ZCode route), the credential (read from DSH's own store
# so no key is ever copied into a repository or a shell history), and the Python
# interpreter (tau2 requires >=3.12,<3.14, which is NOT this machine's default).
#
# ## The key
#
# It is read at runtime from DSH's credential store and exported only into this
# process tree. It is never printed, never written to a file, and never passed as
# an argument. `set -x` is deliberately NOT used.
#
# Usage:
#   bash scripts/run-tau2.sh selfcheck
#   bash scripts/run-tau2.sh gate                 # 2 tasks x 2 arms x 1 rep
#   bash scripts/run-tau2.sh sweep                # 6 tasks x 4 arms x 4 reps
#
# Environment overrides:
#   EF_TAU2_ARM        arm for a single-run invocation (default: basic)
#   EF_TAU2_THRESHOLD  fold threshold ratio (default: 0.5)

set -euo pipefail

MODE="${1:-selfcheck}"
shift || true

EF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# This script's own directory, via `dirname` rather than `${BASH_SOURCE[0]%/*}`:
# the parameter expansion cannot strip a backslash path, so an absolute Windows
# invocation resolved the proxy-env source below to a non-existent
# `...\run-tau2.sh/proxy-env.sh`. See the same fix in run-lhtb.sh.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The τ²-Bench-Verified checkout lives OUTSIDE this repository, so it has to be
# supplied. No default on purpose: a path baked in here would only work on the
# machine it was written on, and this file ships inside a published package.
TAU2_ROOT="${TAU2_ROOT:-}"
[ -n "$TAU2_ROOT" ] || {
  echo "TAU2_ROOT is not set; point it at your tau2-verified checkout" >&2
  echo "  e.g. TAU2_ROOT=/path/to/bench-workspace/tau2-verified $0" >&2
  exit 1
}
TAU2_PY="${TAU2_ROOT}/.venv/Scripts/python.exe"

[ -x "$TAU2_PY" ] || { echo "tau2 venv not found at $TAU2_PY (run: uv sync)" >&2; exit 1; }

# The credential store. Override with DSH_CREDENTIALS, or let it default to the
# standard DSH home. Again no machine-specific fallback.
CREDENTIALS="${DSH_CREDENTIALS:-$HOME/.dsh/.credentials.yaml}"
[ -f "$CREDENTIALS" ] || {
  echo "credential store not found at $CREDENTIALS" >&2
  echo "set DSH_CREDENTIALS to its path" >&2
  exit 1
}

# Read ONE value out of the refs block. Never echoed.
KEY=$("$TAU2_PY" - "$CREDENTIALS" <<'PY'
import re, sys
text = open(sys.argv[1], encoding='utf-8').read()
m = re.search(r'^\s+OPENCODE_GO_API_KEY:\s*(\S+)\s*$', text, re.M)
sys.stdout.write(m.group(1) if m else '')
PY
)
[ -n "$KEY" ] || { echo "OPENCODE_GO_API_KEY not present in the credential store" >&2; exit 1; }
echo "live route: opencode.ai/zen/v1 model=space-bunny-free (key len ${#KEY})"

export EF_ROOT
export EF_LIVE=1
export EF_LIVE_BASE_URL="${EF_LIVE_BASE_URL:-https://opencode.ai/zen/v1}"
export EF_LIVE_API_KEY="$KEY"
export EF_LIVE_MODEL="${EF_LIVE_MODEL:-space-bunny-free}"
# ## The proxy is OPT-IN, because forcing it broke every model call
#
# This used to hardcode `NODE_USE_ENV_PROXY=1` with
# `HTTPS_PROXY=http://127.0.0.1:10808`, on the premise that Node "reaches the
# provider only through the local proxy". Measured on the LHTB lane, where the
# same block lived, that premise is false in BOTH directions:
#
#   direct  https://opencode.ai/zen/v1/models   200, repeatedly
#   proxied via 127.0.0.1:10808                 000, repeatedly
#
# A Node fetch through it dies with a bare `fetch failed`, which the bridge
# reports as `error:fetch failed` — naming neither proxy nor port, so it reads
# like a credential or route fault. Set `EF_USE_PROXY=1` on a network that needs
# one; otherwise the bridge talks to the provider directly.
if [ "${EF_USE_PROXY:-0}" = "1" ]; then
  export NODE_USE_ENV_PROXY=1
  export HTTPS_PROXY="${HTTPS_PROXY:-http://127.0.0.1:10808}"
  export HTTP_PROXY="${HTTP_PROXY:-http://127.0.0.1:10808}"
else
  unset NODE_USE_ENV_PROXY HTTPS_PROXY HTTP_PROXY ALL_PROXY
fi

# The bracketed-IPv6 NO_PROXY defect, scrubbed once for every runner. This is a
# DIFFERENT defect from the HTTPS_PROXY one above: httpx reads a bracketed IPv6
# literal as `host:port` and fails with `Invalid port: ':1]'` before any request
# is sent. See scripts/proxy-env.sh for why the calling shell cannot fix it.
. "${SCRIPT_DIR}/proxy-env.sh"

# Scratch for EF bundles. Kept under the managed temp root so the sweep owns it.
export EF_TAU2_BUNDLE_ROOT="${EF_TAU2_BUNDLE_ROOT:-${TEMP:-/tmp}/ef-tmp/tau2-bundles}"

# The adapter must be importable; it lives in the EF repo, not in the benchmark.
export PYTHONPATH="${EF_ROOT}/eval/tau2:${TAU2_ROOT}/src:${PYTHONPATH:-}"

case "$MODE" in
  selfcheck)
    exec "$TAU2_PY" "${EF_ROOT}/eval/tau2/ef_tau2_adapter.py"
    ;;
  gate|sweep)
    # ## Pass `--out`, or the run leaves no machine-readable record
    #
    # `run_tau2.py` has always accepted `--out` (it writes the cell records as
    # JSON), but this wrapper never passed it — so a sweep produced no archive at
    # all and its numbers survived only as console text. One 96-cell sweep had to
    # be recovered from a log for exactly this reason.
    #
    # The filename is stamped in UTC so two runs cannot collide, and the path is
    # overridable with `EF_TAU2_OUT`.
    OUT="${EF_TAU2_OUT:-${EF_ROOT}/eval/tau2/results/${MODE}-$(date -u +%Y%m%dT%H%M%SZ).json}"
    mkdir -p "$(dirname "$OUT")"
    echo "archive: $OUT"
    exec "$TAU2_PY" "${EF_ROOT}/eval/tau2/run_tau2.py" --preset "$MODE" --out "$OUT" "$@"
    ;;
  *)
    echo "unknown mode: $MODE (expected selfcheck|gate|sweep)" >&2
    exit 2
    ;;
esac
