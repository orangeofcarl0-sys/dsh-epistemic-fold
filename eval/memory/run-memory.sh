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
export EF_LIVE_MODEL="${EF_LIVE_MODEL:-step-5-preview-free}"
# Built in its own variable first. Inside ${VAR:-...} bash does not process backslash escapes
# the way the surrounding quoting suggests, and the value that reached the host was not valid
# JSON -- so the header was silently absent and every request answered HTTP 400
# MissingSessionID, which reads as "the endpoint is up" while nothing can be routed.
_EF_HEADERS="{\"x-opencode-session\":\"ef-memory-$(date +%s)-$$\"}"
export EF_LIVE_HEADERS="${EF_LIVE_HEADERS:-$_EF_HEADERS}"
export EF_BRIDGE_STDERR="${EF_BRIDGE_STDERR:-$EF_HOME/ef-phase7-logs/memory-bridge-stderr.log}"
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

exec "$HARBOR_PY" "$EF_HOME/eval/memory/run_cell.py" "$@"
