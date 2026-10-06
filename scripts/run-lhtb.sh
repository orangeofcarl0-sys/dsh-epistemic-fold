#!/usr/bin/env bash
# Run the LHTB x EF lane against the space-bunny-free route.
#
# ## Why a script
#
# Four environment facts must all be right or the run fails in ways that look
# like benchmark failures: the proxy (OPT-IN, because whether this host needs one
# is a property of the host — see the note on the opt-in block below), the route
# (space-bunny-free is served by OpenCode Zen), the credential (read from DSH's
# own store so no key is copied anywhere), and the Python interpreter (Harbor
# requires >=3.12; this machine's default is 3.11).
#
# ## The key
#
# Read at runtime and exported only into this process tree. Never printed, never
# written to a file, never passed as an argument. `set -x` is deliberately NOT
# used.
#
# ## Concurrency: measured, not assumed
#
# This section used to say the lane was serial "by necessity", because "every
# LHTB task requests 4-8 GB of RAM and this host's WSL VM is capped at 8 GB". The
# first half was wrong in kind and the conclusion was wrong with it:
#
#   - `memory_mb` in a task.toml is the CONTAINER LIMIT, not a reservation.
#     Docker does not preallocate a cgroup limit, so two cells declared at 8 GiB
#     and 4 GiB do not consume 12 GiB.
#   - Measured with both discriminators running: `vector-db-iterative-build` held
#     193 MiB of its 8 GiB limit, `unknown-config-semantics` 16 MiB of its 4 GiB.
#
# The cap is a property of the HOST, so no number for it is written here. This
# note has named two and both were measurements of a different machine: 24, then
# 8, and the 8 was wrong on the host that ran Phase 7 — that host grants more
# memory than the note claimed. Ask the machine when the figure matters
# (`docker info --format '{{.MemTotal}}'`, or `~/.wslconfig`);
# tests/lhtb-parallelism.spec.ts does, and skips rather than guessing on a host it
# cannot ask. What is true of every host is the part that decides the question: a
# `memory_mb` is a limit and not a reservation, and the measured cells are two
# orders of magnitude under their declared ones.
#
# So two cells fit with room for the build and verifier phases, which are what
# actually spike. `n_concurrent_trials` is set from measurement and left at 2.
#
# Usage:
#   bash scripts/run-lhtb.sh probe    # one task, one arm, one attempt
#   EF_LHTB_ARM=economy bash scripts/run-lhtb.sh sweep   # both discriminators, one arm
#   bash scripts/run-lhtb.sh oracle   # the tasks' own reference solutions, no API key
#
# Environment overrides:
#   EF_LHTB_MODE       mode when no positional argument is given (default: probe)
#   EF_LHTB_ARM        context runtime (default: basic)
#   EF_LHTB_BUNDLE_ROOT  where EF bundles are written

set -euo pipefail

EF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# This script's own directory, derived with `dirname` rather than
# `${BASH_SOURCE[0]%/*}`. The parameter expansion cannot strip a BACKSLASH path,
# so on Windows `bash 'C:\...\scripts\run-lhtb.sh' oracle` resolved the
# proxy-env source below to `...\run-lhtb.sh/proxy-env.sh` and died with
# "Not a directory" before doing anything. `dirname` handles both separators;
# the documented relative invocation never exercised the difference.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
# Names the credential, not the route. This line used to assert a hardcoded
# "opencode.ai/zen/v1 model=space-bunny-free" as fact, and kept asserting it after
# the route moved to `/zen/go/v1` — a claim printed before `EF_LIVE_BASE_URL` was
# even read. The route is reported below, from the variables that decide it.
echo "credential: OPENCODE_GO_API_KEY read from the store (len ${#KEY})"

export EF_ROOT
# Harbor agents reach the model through litellm, which reads these.
export OPENAI_API_KEY="$KEY"
export OPENAI_API_BASE="${OPENAI_API_BASE:-https://opencode.ai/zen/v1}"
export EF_LIVE_BASE_URL="${EF_LIVE_BASE_URL:-https://opencode.ai/zen/v1}"
export EF_LIVE_API_KEY="$KEY"
export EF_LIVE_MODEL="${EF_LIVE_MODEL:-space-bunny-free}"

# ## `/zen/go/v1` requires a session id on every request
#
# That route answers `400 MissingSessionID` ("cannot be routed efficiently") on
# every call without an `x-opencode-session` header, where the sibling `/zen/v1`
# route does not ask for one. It is a property of the ROUTE rather than of any
# model, so it is supplied here and travels with the route through
# `EF_LIVE_HEADERS` (read by `eval/live/zcode-config.ts`).
#
# A per-run id is enough: the endpoint uses it to route, not to authenticate — the
# credential is still the bearer token. Override `EF_LIVE_HEADERS` directly to
# replace it.
if [ -z "${EF_LIVE_HEADERS:-}" ]; then
  case "$EF_LIVE_BASE_URL" in
    */zen/go/*)
      export EF_LIVE_HEADERS="{\"x-opencode-session\":\"ef-lhtb-$(date +%s)-$$\"}"
      ;;
  esac
fi
# Print the NAMES only: a route may carry values that do not belong in a log.
if [ -n "${EF_LIVE_HEADERS:-}" ]; then
  echo "route: ${EF_LIVE_BASE_URL} model=${EF_LIVE_MODEL} headers=$(printf '%s' "$EF_LIVE_HEADERS" | grep -o '"[^"]*"[[:space:]]*:' | tr -d '":' | tr '\n' ',' | sed 's/,$//')"
fi

# ## The proxy is OPT-IN, because forcing it broke every model call
#
# This block used to hardcode `NODE_USE_ENV_PROXY=1` with
# `HTTPS_PROXY=http://127.0.0.1:10808`, on the stated premise that "Node (the EF
# bridge host) reaches the provider only through the local proxy". Measured on
# this host, that premise is false in BOTH directions:
#
#   direct  https://opencode.ai/zen/v1/models   200, repeatedly
#   proxied via 127.0.0.1:10808                 000, repeatedly
#
# A Node fetch through that proxy dies with a bare `fetch failed`, which the
# bridge reports as `error:fetch failed` — a message naming neither the proxy nor
# the port, so it reads like a credential or route fault. It cost a debugging
# round here for exactly that reason.
#
# The proxy is therefore supplied only when asked for. Set `EF_USE_PROXY=1` (and
# optionally `HTTPS_PROXY`) on a network that needs one; otherwise the bridge
# talks to the provider directly, which is what works here.
if [ "${EF_USE_PROXY:-0}" = "1" ]; then
  export NODE_USE_ENV_PROXY=1
  export HTTPS_PROXY="${HTTPS_PROXY:-http://127.0.0.1:10808}"
  export HTTP_PROXY="${HTTP_PROXY:-http://127.0.0.1:10808}"
  echo "proxy: enabled (${HTTPS_PROXY})"
else
  unset NODE_USE_ENV_PROXY HTTPS_PROXY HTTP_PROXY ALL_PROXY
  echo "proxy: disabled (direct); set EF_USE_PROXY=1 to route through one"
fi

# The bracketed-IPv6 NO_PROXY defect, scrubbed once for every runner. A DIFFERENT
# defect from the HTTPS_PROXY one above: httpx reads a bracketed IPv6 literal as
# `host:port` and fails with `Invalid port: ':1]'` before any request is sent, so
# it breaks Harbor's embedded LiteLLM and the judge endpoint rather than Node.
# Sourced AFTER the opt-in block, because that block unsets the proxy variables
# and this file sets only NO_PROXY. See scripts/proxy-env.sh.
. "${SCRIPT_DIR}/proxy-env.sh"

# Many LHTB images are amd64-only.
export DOCKER_DEFAULT_PLATFORM="${DOCKER_DEFAULT_PLATFORM:-linux/amd64}"

# The EF adapter modules and the shared bridge client.
export PYTHONPATH="${EF_ROOT}/eval/lhtb:${EF_ROOT}/eval/tau2:${PYTHONPATH:-}"

export EF_LHTB_ARM="${EF_LHTB_ARM:-basic}"
export EF_LHTB_BUNDLE_ROOT="${EF_LHTB_BUNDLE_ROOT:-${TEMP:-/tmp}/ef-tmp/lhtb-bundles}"

# The bridge host's stderr goes to a file, because Harbor captures the agent's
# own output and a transport failure inside the bridge otherwise leaves no trace.
export EF_BRIDGE_STDERR="${EF_BRIDGE_STDERR:-${EF_LHTB_BUNDLE_ROOT%/lhtb-bundles}/bridge-stderr.log}"

# A larger completion budget than tau2's 900. LHTB agents write heredocs and
# multi-line scripts; a reply truncated at 900 tokens arrives as `max-tokens`
# carrying nothing usable.
export EF_BRIDGE_MAX_TOKENS="${EF_BRIDGE_MAX_TOKENS:-4096}"

# ## Verify the route in the transport that will actually use it
#
# This is the precondition the handoff used to state as a `curl`. That check is
# wrong in kind and it cost a full probe: `opencode.ai` resolves to nine A
# records, four of which refuse TCP 443, and curl falls back across the set while
# Node's fetch — which the bridge is — does not. So curl reported 200 while every
# model call in the run died as `error:fetch failed`.
#
# The probe below asks the question with the bridge's own transport. It costs one
# request and it runs BEFORE Harbor pulls images, so a transport fault is found in
# seconds instead of after the episode budget. Skip with EF_SKIP_ROUTE_CHECK=1
# when a run is deliberately being made against a route that is down.
if [ "${EF_SKIP_ROUTE_CHECK:-0}" != "1" ]; then
  if ! node "${SCRIPT_DIR}/check-route.mjs"; then
    echo "route preflight failed; a run would fail every model call." >&2
    echo "Fix the route (or set EF_USE_PROXY=1 if it needs a proxy), or set" >&2
    echo "EF_SKIP_ROUTE_CHECK=1 to run anyway." >&2
    exit 1
  fi
fi

# ## The mode selects the config, and it is read HERE on purpose
#
# The mode is the FIRST POSITIONAL argument (`run-lhtb.sh sweep`); EF_LHTB_MODE
# supplies it when no argument is given, so a caller driving the arms from the
# environment (as the sweep loop does) need not build an argv. This block did not
# exist at all: the runner ignored its
# argument entirely and always passed `lhtb-ef-probe.yaml`, so `sweep` and
# `oracle` both ran a one-task, one-attempt probe while printing a normal-looking
# run. That is the worst failure mode available here — it is indistinguishable
# from a sweep that legitimately found nothing — and the Phase 7 handoff invokes
# both of those modes. An unrecognised mode is a hard error rather than a default,
# so a typo cannot silently degrade to a probe either.
MODE="${1:-${EF_LHTB_MODE:-probe}}"
shift || true
case "$MODE" in
  probe)  CONFIG_SRC="lhtb-ef-probe.yaml" ;;
  sweep)  CONFIG_SRC="lhtb-ef-sweep.yaml" ;;
  oracle) CONFIG_SRC="lhtb-ef-oracle.yaml" ;;
  *)
    echo "unknown mode: ${MODE} (expected probe | sweep | oracle)" >&2
    exit 1
    ;;
esac
export EF_LHTB_MODE="$MODE"

echo "LHTB ${MODE}: arm=${EF_LHTB_ARM} config=${CONFIG_SRC}"

# The config's dataset path is relative to the WORKING DIRECTORY, and Harbor
# resolves it there. Running from the EF repo would make `./tasks` resolve to a
# path that does not exist, so the run happens from the benchmark checkout.
cd "$LHTB_ROOT"

# Fail loudly if the selected config is absent, rather than letting Harbor read a
# path that does not exist and report something that looks like a task failure.
[ -f "${EF_ROOT}/eval/lhtb/${CONFIG_SRC}" ] || {
  echo "config not found: ${EF_ROOT}/eval/lhtb/${CONFIG_SRC}" >&2
  exit 1
}

# A UNIQUE job name per invocation.
#
# Harbor keys its output on `job_name` and, finding one already present, exits
# immediately while still reporting the previous run's runtime and reward. An
# invocation that measures nothing while appearing to succeed is the worst
# failure mode available here, so each run gets its own directory. The mode AND
# the arm are both in the suffix, because the four sweep arms share a mode and
# must not collide on it.
JOB_SUFFIX="$(date +%Y%m%d-%H%M%S)-${MODE}-${EF_LHTB_ARM}"
CONFIG_TMP="${TMPDIR:-/tmp}/lhtb-ef-${JOB_SUFFIX}.yaml"

# ## The config's model_name must name the model the run actually used
#
# The adapter takes its model from EF_LIVE_MODEL, so the config's model_name is
# a LABEL -- but Harbor prints it, and the Phase 7 summary line read
# "tasks | ef-lhtb | space-bunny-free" while every call was going to
# longcat-2.5-preview-free. A record that names the wrong model is the same class
# of defect as a report that cannot name its revision: the archive looks complete
# and is describing something else.
#
# Substituted here rather than edited into the config, for the reason the runner
# already has no default LHTB_ROOT: a tracked file naming one machine's route is
# wrong on every other one.
sed -e "s/^job_name: .*/job_name: lhtb-ef-${JOB_SUFFIX}/" \
  -e "s|^    model_name: .*|    model_name: openai/${EF_LIVE_MODEL}|" \
  "${EF_ROOT}/eval/lhtb/${CONFIG_SRC}" > "$CONFIG_TMP"

echo "job: lhtb-ef-${JOB_SUFFIX}"
exec "$HARBOR_EXE" run -c "$CONFIG_TMP"
