#!/usr/bin/env bash
# Launch the memory-pressure driver with the same route the LHTB lane uses.
#
# The credential is read from the store and exported, never passed as an argument, so it cannot
# appear in a process listing. The route needs the x-opencode-session header: without it the
# endpoint answers a fast 400, which reads as "the endpoint is fine" while every real request
# would fail.
set -uo pipefail
EF_HOME="${EF_HOME:-D:/Data and code/xuchengjian/workplace/dsh-epistemic-fold}"
cd "$EF_HOME" || exit 1

CREDENTIALS="${DSH_CREDENTIALS:-$HOME/.dsh/.credentials.yaml}"
[ -f "$CREDENTIALS" ] || { echo "credential store not found at $CREDENTIALS" >&2; exit 1; }
HARBOR_PY="D:/Data and code/xuchengjian/workplace/bench-workspace/lhtb/harbor/.venv/Scripts/python.exe"
KEY=$("$HARBOR_PY" - "$CREDENTIALS" <<'PY'
import re, sys
text = open(sys.argv[1], encoding='utf-8').read()
m = re.search(r'^\s+OPENCODE_GO_API_KEY:\s*(\S+)\s*$', text, re.M)
sys.stdout.write(m.group(1) if m else '')
PY
)
[ -n "$KEY" ] || { echo "OPENCODE_GO_API_KEY not present in the credential store" >&2; exit 1; }

export EF_ROOT="$EF_HOME"
export EF_LIVE_BASE_URL="${EF_LIVE_BASE_URL:-https://opencode.ai/zen/go/v1}"
export EF_LIVE_API_KEY="$KEY"
# `step-5-preview-free` is no longer served: it answers HTTP 400 "Model is
# unavailable", so the documented invocation could not run at all. `beam-free`
# is the free model this route actually serves; measured 2026-10-18.
export EF_LIVE_MODEL="${EF_LIVE_MODEL:-beam-free}"

# ## The step reply budget, and why its default was wrong for this bench
#
# `STEP_MAX_TOKENS` defaults to 900 (eval/tau2/bridge-host.ts:99) and NEITHER
# this script NOR run_cell.py ever set it, so every probe ran at 900. On a
# reasoning model the cap is spent on reasoning AND content together, so the
# model frequently answered with nothing at all. Measured 2026-10-18, same arm,
# same window, same route:
#
#     EF_BRIDGE_MAX_TOKENS=900   economy  204/204 unparsed  finish=max-tokens
#     EF_BRIDGE_MAX_TOKENS=8192  economy  204/204 parsed    finish=stop
#
# and it moved accuracy, not just the parse rate: economy's mean over n=5 went
# from ~0.81 at 900 to ~0.90 at 8192. run_cell.py:502 already listed "the reply
# budget being 900 tokens for a 204-line answer" among three defects the artifact
# could not diagnose; the whitelist was widened then, the budget itself never was.
# An explicit EF_BRIDGE_MAX_TOKENS still wins.
export EF_BRIDGE_MAX_TOKENS="${EF_BRIDGE_MAX_TOKENS:-8192}"
# Built in its own variable first. Inside ${VAR:-...} bash does not process backslash escapes
# the way the surrounding quoting suggests, and the value that reached the host was not valid
# JSON -- so the header was silently absent and every request answered HTTP 400
# MissingSessionID, which reads as "the endpoint is up" while nothing can be routed.
_EF_HEADERS="{\"x-opencode-session\":\"ef-memory-$(date +%s)-$$\"}"
export EF_LIVE_HEADERS="${EF_LIVE_HEADERS:-$_EF_HEADERS}"
export EF_BRIDGE_STDERR="${EF_BRIDGE_STDERR:-$EF_HOME/ef-phase7-logs/memory-bridge-stderr.log}"

# ## The window knob is ONE knob, not two (fixed 2026-10-17)
#
# `EF_MEMORY_WINDOW` sets the calibration TARGET (run_cell.py:262) while the engine folds against
# `EF_TAU2_WINDOW` (eval/tau2/bridge-host.ts:131, default 32,000). This script set NEITHER, so a
# caller that exported only `EF_MEMORY_WINDOW` got a target computed for one window and an engine
# folding against another -- and the artifact recorded only the first, so a reader could not tell.
#
# Measured 2026-10-17: at `EF_MEMORY_WINDOW=258048` with the engine left at its default, the
# post-fold surface was 11,074 tokens. `retainTokens = 0.24 * W_engine` bounds it from below, so
# 11,074 implies W_engine <= 46,142 -- the engine was NOT at 258,048. With both set, retain is
# 61,931 and the surface settles near 65,888, which is consistent.
#
# Deriving one from the other is the fix the audit recommended: a caller cannot set half a knob it
# does not know is split, and an explicit `EF_TAU2_WINDOW` still wins.
export EF_MEMORY_WINDOW="${EF_MEMORY_WINDOW:-131072}"
export EF_TAU2_WINDOW="${EF_TAU2_WINDOW:-$EF_MEMORY_WINDOW}"
echo "window: EF_MEMORY_WINDOW=$EF_MEMORY_WINDOW  EF_TAU2_WINDOW=$EF_TAU2_WINDOW"
echo "route: $EF_LIVE_BASE_URL model=$EF_LIVE_MODEL"

# The proxy, discovered the same way run-lhtb.sh discovers it: a port that answers.
if [ "${EF_USE_PROXY:-1}" = "1" ] && [ -z "${HTTPS_PROXY:-}" ]; then
  for _p in 7890 7897 10808 1080 7891; do
    _code=$(curl.exe -s -o /dev/null -w '%{http_code}' --max-time 2 --noproxy '*' "http://127.0.0.1:$_p" 2>/dev/null)
    if [ "$_code" != "000" ]; then
      export HTTPS_PROXY="http://127.0.0.1:$_p"; export HTTP_PROXY="$HTTPS_PROXY"
      export NODE_USE_ENV_PROXY=1
      echo "proxy: enabled ($HTTPS_PROXY)"
      break
    fi
  done
fi
[ -n "${HTTPS_PROXY:-}" ] || echo "proxy: disabled (direct)"

if [ "${1:-}" = "--check-route" ]; then
  exec "$HARBOR_PY" "$EF_HOME/eval/memory/check_route.py"
fi
exec "$HARBOR_PY" "$EF_HOME/eval/memory/run_cell.py" "$@"
