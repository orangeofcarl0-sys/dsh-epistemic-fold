#!/usr/bin/env bash
# Run the LHTB x EF lane against the space-bunny-free route.
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
# ## Modes
#
#   probe   one task, one arm, one attempt (the integration check)
#   sweep   both discriminators x N attempts, one arm per invocation
#   oracle  the tasks' own reference solutions; no API key, so it validates the
#           environment and the hidden verifier without spending anything
#
# ## Parallelism, corrected
#
# An earlier revision said a parallel run was impossible: "every LHTB task
# requests 4-8 GB of RAM and this host's WSL VM is capped at 8 GB". Measured on
# this host, both halves of that were wrong:
#
#   - the WSL cap is 24 GB (~/.wslconfig), not 8 GB;
#   - `memory_mb` is the container's LIMIT, not a reservation. With both
#     discriminators running, vector-db held 108 MiB of its 8 GiB and
#     unknown-config 16 MiB of its 4 GiB.
#
# The binding constraint is the build and verifier phases, which is why
# `n_concurrent_trials` is set from measurement in the config rather than from
# the declared per-task limit.
#
# ## One arm per invocation
#
# `EF_LHTB_ARM` is read by the adapter from the environment, so one process is
# one arm. That is deliberate: four separate invocations are four separate
# provider windows, and the tau2 lane already showed - three sweeps, three
# different winners - that a per-arm window can masquerade as a mode effect.
#
# Usage:
#   bash scripts/run-lhtb.sh probe
#   EF_LHTB_ARM=economy bash scripts/run-lhtb.sh sweep
#   EF_LHTB_ATTEMPTS=4 bash scripts/run-lhtb.sh sweep
#
# Environment overrides:
#   EF_LHTB_ARM        context runtime (default: basic)
#   EF_LHTB_ATTEMPTS   replicates in sweep mode (default: the config's value)
#   EF_LHTB_BUNDLE_ROOT  where EF bundles are written

set -euo pipefail

EF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The LHTB checkout lives OUTSIDE this repository (it is a separate project with
# its own Python environment), so it has to be supplied. There is deliberately no
# default: a path baked in here would only work on the machine it was written on,
# and this file ships inside a published package.
LHTB_ROOT="${LHTB_ROOT:-}"
[ -n "$LHTB_ROOT" ] || {
  echo "LHTB_ROOT is not set; point it at your LHTB checkout" >&2
  echo "  e.g. LHTB_ROOT=/path/to/bench-workspace/lhtb $0" >&2
  exit 1
}
HARBOR_PY="${LHTB_ROOT}/harbor/.venv/Scripts/python.exe"
HARBOR_EXE="${LHTB_ROOT}/harbor/.venv/Scripts/harbor.exe"

[ -x "$HARBOR_EXE" ] || { echo "harbor not installed at $HARBOR_EXE" >&2; exit 1; }

# The credential store. Override with DSH_CREDENTIALS, or let it default to the
# standard DSH home. Again no machine-specific fallback.
CREDENTIALS="${DSH_CREDENTIALS:-$HOME/.dsh/.credentials.yaml}"
[ -f "$CREDENTIALS" ] || {
  echo "credential store not found at $CREDENTIALS" >&2
  echo "set DSH_CREDENTIALS to its path" >&2
  exit 1
}

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

export EF_LHTB_MODE="${EF_LHTB_MODE:-probe}"
export EF_LHTB_ARM="${EF_LHTB_ARM:-basic}"
export EF_LHTB_BUNDLE_ROOT="${EF_LHTB_BUNDLE_ROOT:-${TEMP:-/tmp}/ef-tmp/lhtb-bundles}"

# The bridge host's stderr goes to a file, because Harbor captures the agent's
# own output and a transport failure inside the bridge otherwise leaves no trace.
export EF_BRIDGE_STDERR="${EF_BRIDGE_STDERR:-${EF_LHTB_BUNDLE_ROOT%/lhtb-bundles}/bridge-stderr.log}"

# A larger completion budget than tau2's 900. LHTB agents write heredocs and
# multi-line scripts; a reply truncated at 900 tokens arrives as `max-tokens`
# carrying nothing usable.
export EF_BRIDGE_MAX_TOKENS="${EF_BRIDGE_MAX_TOKENS:-4096}"

# The config's dataset path is relative to the WORKING DIRECTORY, and Harbor
# resolves it there. Running from the EF repo would make `./tasks` resolve to a
# path that does not exist, so the run happens from the benchmark checkout.
cd "$LHTB_ROOT"

# A UNIQUE job name per invocation.
#
# Harbor keys its output on `job_name` and, finding one already present, exits
# immediately while still reporting the previous run's runtime and reward. An
# invocation that measures nothing while appearing to succeed is the worst
# failure mode available here, so each run gets its own directory.
JOB_SUFFIX="$(date +%Y%m%d-%H%M%S)-${EF_LHTB_ARM}"
CONFIG_TMP="${TMPDIR:-/tmp}/lhtb-ef-${JOB_SUFFIX}.yaml"

case "${EF_LHTB_MODE}" in
  sweep)
    # Both discriminators, N attempts. `n_attempts` is overridden only when the
    # caller asks, because Harbor reads it from the config otherwise and the
    # config is the thing worth reviewing.
    if [ -n "${EF_LHTB_ATTEMPTS:-}" ]; then
      sed -e "s/^job_name: .*/job_name: lhtb-ef-sweep-${JOB_SUFFIX}/" \
          -e "s/^n_attempts: .*/n_attempts: ${EF_LHTB_ATTEMPTS}/" \
          "${EF_ROOT}/eval/lhtb/lhtb-ef-sweep.yaml" > "$CONFIG_TMP"
    else
      sed -e "s/^job_name: .*/job_name: lhtb-ef-sweep-${JOB_SUFFIX}/" \
          "${EF_ROOT}/eval/lhtb/lhtb-ef-sweep.yaml" > "$CONFIG_TMP"
    fi
    echo "LHTB sweep: arm=${EF_LHTB_ARM} tasks=unknown-config-semantics,vector-db-iterative-build"
    ;;
  oracle)
    # The benchmark's own reference solutions. `oracle` is a built-in Harbor
    # agent, so the EF adapter is not referenced at all and no key is needed.
    # This is what proves the images pull, the containers start and the HIDDEN
    # verifier scores, before any of it is spent against the provider.
    sed "s/^job_name: .*/job_name: lhtb-oracle-${JOB_SUFFIX}/" \
      "${EF_ROOT}/eval/lhtb/lhtb-ef-oracle.yaml" > "$CONFIG_TMP"
    echo "LHTB oracle: reference solutions, no API key (environment + verifier check)"
    ;;
  *)
    echo "LHTB probe: task=unknown-config-semantics arm=${EF_LHTB_ARM} (serial)"
    sed "s/^job_name: .*/job_name: lhtb-ef-${JOB_SUFFIX}/" \
      "${EF_ROOT}/eval/lhtb/lhtb-ef-probe.yaml" > "$CONFIG_TMP"
    ;;
esac

echo "job: ${CONFIG_TMP##*/lhtb-}"
exec "$HARBOR_EXE" run -c "$CONFIG_TMP"
