#!/usr/bin/env bash
# Run the LHTB x EF serial probe against the space-bunny-free route.
#
# ## Why a script
#
# Four environment facts must all be right or the run fails in ways that look
# like benchmark failures: the proxy (this machine reaches the provider only
# through a local HTTP proxy), the route (space-bunny-free is served by OpenCode
# Zen), the credential (read from DSH's own store so no key is copied anywhere),
# and the Python interpreter (Harbor requires >=3.12; this machine's default is
# 3.11).
#
# ## The key
#
# Read at runtime and exported only into this process tree. Never printed, never
# written to a file, never passed as an argument. `set -x` is deliberately NOT
# used.
#
# ## Serial by necessity
#
# Every LHTB task requests 4-8 GB of RAM and this host's WSL VM is capped at
# 8 GB, so at most one trial runs at a time. A parallel LHTB run is not possible
# here, which is exactly why the tau2 lane carries the statistical work.
#
# Usage:
#   bash scripts/run-lhtb.sh probe
#   EF_LHTB_ARM=economy bash scripts/run-lhtb.sh probe
#
# Environment overrides:
#   EF_LHTB_ARM        context runtime (default: basic)
#   EF_LHTB_BUNDLE_ROOT  where EF bundles are written

set -euo pipefail

EF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LHTB_ROOT="${LHTB_ROOT:-/f/Codex_Work_Space/bench-workspace/lhtb}"
HARBOR_PY="${LHTB_ROOT}/harbor/.venv/Scripts/python.exe"
HARBOR_EXE="${LHTB_ROOT}/harbor/.venv/Scripts/harbor.exe"

[ -x "$HARBOR_EXE" ] || { echo "harbor not installed at $HARBOR_EXE" >&2; exit 1; }

CREDENTIALS="${DSH_CREDENTIALS:-$HOME/.dsh/.credentials.yaml}"
[ -f "$CREDENTIALS" ] || CREDENTIALS="D:/dsh/.credentials.yaml"
[ -f "$CREDENTIALS" ] || { echo "credential store not found" >&2; exit 1; }

# Read ONE value out of the refs block. Never echoed.
KEY=$("$HARBOR_PY" - "$CREDENTIALS" <<'PY'
import re, sys
text = open(sys.argv[1], encoding='utf-8').read()
m = re.search(r'^\s+OPENCODE_GO_API_KEY:\s*(\S+)\s*$', text, re.M)
sys.stdout.write(m.group(1) if m else '')
PY
)
[ -n "$KEY" ] || { echo "OPENCODE_GO_API_KEY not present in the credential store" >&2; exit 1; }
echo "live route: opencode.ai/zen/v1 model=space-bunny-free (key len ${#KEY})"

export EF_ROOT
# Harbor agents reach the model through litellm, which reads these.
export OPENAI_API_KEY="$KEY"
export OPENAI_API_BASE="${OPENAI_API_BASE:-https://opencode.ai/zen/v1}"
export EF_LIVE_BASE_URL="${EF_LIVE_BASE_URL:-https://opencode.ai/zen/v1}"
export EF_LIVE_API_KEY="$KEY"
export EF_LIVE_MODEL="${EF_LIVE_MODEL:-space-bunny-free}"

# Node (the EF bridge host) reaches the provider only through the local proxy.
export NODE_USE_ENV_PROXY=1
export HTTPS_PROXY="${HTTPS_PROXY:-http://127.0.0.1:10808}"
export HTTP_PROXY="${HTTP_PROXY:-http://127.0.0.1:10808}"

# Many LHTB images are amd64-only.
export DOCKER_DEFAULT_PLATFORM="${DOCKER_DEFAULT_PLATFORM:-linux/amd64}"

# The EF adapter modules and the shared bridge client.
export PYTHONPATH="${EF_ROOT}/eval/lhtb:${EF_ROOT}/eval/tau2:${PYTHONPATH:-}"

export EF_LHTB_ARM="${EF_LHTB_ARM:-basic}"
export EF_LHTB_BUNDLE_ROOT="${EF_LHTB_BUNDLE_ROOT:-${TEMP:-/tmp}/ef-tmp/lhtb-bundles}"

echo "LHTB probe: task=unknown-config-semantics arm=${EF_LHTB_ARM} (serial)"

# The config's dataset path is relative to the WORKING DIRECTORY, and Harbor
# resolves it there. Running from the EF repo would make `./tasks` resolve to a
# path that does not exist, so the run happens from the benchmark checkout.
cd "$LHTB_ROOT"
exec "$HARBOR_EXE" run -c "${EF_ROOT}/eval/lhtb/lhtb-ef-probe.yaml"
