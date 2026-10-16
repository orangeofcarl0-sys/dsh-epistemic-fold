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
export OPENAI_API_BASE="${OPENAI_API_BASE:-https://opencode.ai/zen/go/v1}"
export EF_LIVE_BASE_URL="${EF_LIVE_BASE_URL:-https://opencode.ai/zen/go/v1}"
export EF_LIVE_API_KEY="$KEY"
export EF_LIVE_MODEL="${EF_LIVE_MODEL:-step-5-preview-free}"

# ## The FOLD WINDOW must be the MODEL's window, not a lane constant
#
# `eval/tau2/bridge-host.ts:101` prices every fold against `EF_TAU2_WINDOW`, whose
# default is 32_000 -- a value chosen for the tau2 lane (662d468). LHTB inherited it, so
# a model whose window is at least 250K was folded at
# `min(32000 x 0.5, 32000 - reserve) = 16_000` tokens (`bridge-host.ts:1400`,
# `src/policy.ts:386-431`) while THIS task's own working set is 16_471 tokens:
#
#     instruction.md 1,625   spec.md 1,160   cfg_daemon.py 7,831   cfg_cli.py 1,904
#     engine.py 1,344        engine_runner.py 688   cfgd_public.json 1,920
#
# So every fold evicted 7-11K tokens of material the agent had just read. Measured on
# the 4.1F round: 50-109 folds per cell against step-5's 2-17 on the SAME threshold,
# 489K-803K tokens evicted per episode (the working set 30-49 times), `cfg_daemon.py`
# re-read 127-168 times against 26-27 in the no-fold arm, and 10 of 11 cells never wrote
# the deliverable. See docs/65.
#
# The escape hatch existed and was never used: `EF_TAU2_WINDOW` appears exactly ONCE in
# this repository -- at its own default. It is set HERE rather than by changing that
# default, because 32K is the tau2 lane's recorded choice and RC9's null result was
# measured at it; rewriting the default would silently rewrite that record.
#
# ## Measured where it can be, and NAMED AS AN ASSUMPTION where it cannot
#
# The route's `/models` publishes no context length (id/object/created/owned_by only),
# so a window cannot be read off the API. For `deepseek-v4.1-flash` it was measured
# instead: a ~250K-token prompt was accepted with HTTP 200, so 131_072 is conservative
# for it rather than a guess. Every other model takes the adapter's own default
# (`eval/live/openai-adapter.ts:229`, also 131_072) and SAYS SO, so a reader can tell a
# measured window from an assumed one.
model_window() {
  case "$1" in
    deepseek-v4.1-flash*) echo 131072 ;;  # measured for the FAMILY: >=250K-token prompt accepted
    *) echo 131072 ;;
  esac
}
export EF_TAU2_WINDOW="${EF_TAU2_WINDOW:-$(model_window "$EF_LIVE_MODEL")}"
case "$EF_LIVE_MODEL" in
  deepseek-v4.1-flash*) echo "window: EF_TAU2_WINDOW=${EF_TAU2_WINDOW} (measured for this model family)" ;;
  *) echo "window: EF_TAU2_WINDOW=${EF_TAU2_WINDOW} ASSUMED for ${EF_LIVE_MODEL} (adapter default, not measured on this route)" ;;
esac

# ## The request deadline, set per model for the same reason the window is
#
# `eval/live/openai-adapter.ts:195` defaults to 120_000, and that number was MEASURED on
# the LongCat route: its longest legitimate call was 40s, and raising the deadline to five
# minutes took it from 4.8 model calls in 6 minutes to 2.7 in 25 -- a long deadline spends
# budget waiting on hangs. So the default is right FOR LONGCAT and is left alone here.
#
# `deepseek-v4.1-flash` needs more, and the bridge now measures why
# (`telemetry.timing.callMs`, added for exactly this): at 8-way concurrency its calls
# averaged 47.9s with a 64.4s last call, and one call in seven reported 120_004ms -- the
# deadline EXACTLY, i.e. it was aborted, not slow. An aborted call is not a slow call: the
# bridge closes the turn empty, so the cell pays 120s and receives nothing.
#
# 300_000 leaves ~6x the measured mean and ~4.7x the measured maximum -- the headroom the
# original 120_000 was chosen to provide on LongCat. Whether it IMPROVES calls per cell is
# not assumed: `telemetry.timing` reports it on the next wave.
model_request_timeout() {
  case "$1" in
    # PREFIX, not the exact paid name. Matching only `deepseek-v4.1-flash` silently gave every
    # sibling -- including the `-free` variant, which is the SAME model -- the 120s default, whose
    # aborts are what filled the budget with standing reservations for calls that never answered.
    deepseek-v4.1-flash*) echo 300000 ;;  # measured: mean 47.9s, max 64.4s; 120s aborts
    *) echo 120000 ;;
  esac
}
export EF_LIVE_REQUEST_TIMEOUT_MS="${EF_LIVE_REQUEST_TIMEOUT_MS:-$(model_request_timeout "$EF_LIVE_MODEL")}"
echo "request deadline: EF_LIVE_REQUEST_TIMEOUT_MS=${EF_LIVE_REQUEST_TIMEOUT_MS} for ${EF_LIVE_MODEL}"

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
# ## The proxy port MOVED, so the default was a dead one -- and it defaulted to OFF
#
# Two independent faults, both measured, both fixed here.
#
# 1. THE PORT. The default was http://127.0.0.1:10808. That port stopped listening when
#    the local proxy moved to 7890, and a refused connection is indistinguishable from
#    "the proxy is broken" -- so an enabled proxy looked like a bad idea and got disabled.
#    The port is now DISCOVERED from a candidate list rather than assumed.
#
# 2. WHICH ROUTE. EF_USE_PROXY defaulted to 0 (direct) on the premise that direct was the
#    stable one. Measured within the same minute, 20 sequential realistic requests each:
#
#      direct  :  0 ok, 20x "fetch failed"        -- completely down
#      proxy   :  6 ok, 14x HTTP 429              -- degraded but WORKING
#
#    Direct is not "the good route"; it is a route that periodically dies outright. The
#    proxy degrades instead. Caution default is therefore ENABLED.
#
# What neither fixes: the 429s themselves. "Upstream request failed: Endpoint is
# unavailable" came back at ~70% through BOTH routes, with zero network errors, so it is
# provider-side capacity on this model tier rather than anything the harness controls.
# ~30% of nominal throughput is the number every budget calculation must carry.
EF_USE_PROXY="${EF_USE_PROXY:-1}"
if [ "${EF_USE_PROXY}" = "1" ] && [ -z "${HTTPS_PROXY:-}" ]; then
  # A FILE, not an inline node -e: the inline form fails silently under PowerShell,
  # reported "no port" while the port was open, and the harness fell back to direct.
  # A PATH-FREE probe. The node version printed the right port when run by hand and
  # found NOTHING inside this script: $0 has a different shape under the real
  # invocation, so the resolved path was wrong, and 2>/dev/null hid the failure.
  # A probe that cannot be observed failing is worse than a constant, because the
  # fallback is the route measured at 0 of 20.
  #
  # curl needs no path and proves life either way: the proxy answers a plain request
  # with 400, and 000 means nothing is listening.
  FOUND_PORT=""
  for _p in 7890 7897 10808 1080 7891; do
    _code="$(curl.exe -s -o /dev/null -w '%{http_code}' --max-time 2 --noproxy '*' \
      "http://127.0.0.1:${_p}" 2>/dev/null)"
    if [ -n "${_code}" ] && [ "${_code}" != "000" ]; then
      FOUND_PORT="${_p}"
      break
    fi
  done
  if [ -n "${FOUND_PORT}" ]; then
    export HTTPS_PROXY="http://127.0.0.1:${FOUND_PORT}"
    export HTTP_PROXY="${HTTPS_PROXY}"
  else
    EF_USE_PROXY=0
  fi
fi
if [ "${EF_USE_PROXY}" = "1" ]; then
  export NODE_USE_ENV_PROXY=1
  echo "proxy: enabled (${HTTPS_PROXY})"
else
  unset NODE_USE_ENV_PROXY HTTPS_PROXY HTTP_PROXY ALL_PROXY
  echo "proxy: disabled (direct); no proxy port answered, or EF_USE_PROXY=0"
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
#
# ## Raised to 8192 because the route now serves REASONING models
#
# `max_tokens` caps reasoning AND content together, and these models spend much
# of it reasoning. Measured on step-5-preview-free, asking only for a one-line
# reply:
#
#     max_tokens=16   finish=length  reasoning=16  contentLen=0
#     max_tokens=64   finish=length  reasoning=64  contentLen=0
#     max_tokens=256  finish=stop    reasoning=78  contentLen=76
#
# At 16 and 64 the reasoning consumed the entire budget and the reply was EMPTY,
# which is exactly the `max-tokens`-carrying-nothing failure this comment already
# describes -- reached at a much higher number than 4096 was chosen against. The
# measured reasoning share ranged from 47% to 82% of the completion, so a budget
# sized for a non-reasoning model leaves under half of itself for the answer.
#
# Reasoning length does NOT track the cap: 47 tokens at cap 1024 against 82 at
# cap 4096 on the same prompt. Raising this therefore does not invite rambling;
# it stops the reasoning from eating the reply.
# ## Raised again to 32768: 8192 was still spent ENTIRELY on reasoning
#
# The step-5 round measured this failure at the reply layer. One `basic` cell
# returned five CONSECUTIVE empty replies, every one of them finishing `max-tokens`:
#
#     turn 52..56   anomaly "empty response"  streak 1..5  finishReason "max-tokens"
#     termination   "empty-streak (5, last finish max-tokens)"  at 56 model calls
#
# An empty reply that finishes `max-tokens` proves every output token went to
# something other than content, and reasoning is the only other consumer. So 8192
# was not a reply budget at all in that context, and the cell burned 1.04M tokens of
# a four-hour budget before the empty-streak ceiling ended it. An `economy` cell
# reached 4 of the same 5 and would have died identically.
#
# 32768 is the SUMMARIZATION budget already chosen for exactly this reason, applied
# to the agent's own replies. It is a cap and not a target, so it costs nothing
# unless the model actually uses the room -- and `ef_lhtb_agent.py` now escalates
# further from here (EF_LHTB_REPLY_MAX_TOKENS defaults to this value) if even it is
# spent on reasoning.
export EF_BRIDGE_MAX_TOKENS="${EF_BRIDGE_MAX_TOKENS:-32768}"

# ## The TURN budget must outlast the protocol it exists to allow
#
# `eval/lhtb/ef_lhtb_agent.py:59` defaults this to 400, and nothing ever raised it.
# Measured on the 4.1F round: every EF cell ended `turn-budget-exhausted` at 401-412
# model calls -- about 2h31m into a task whose own agent budget is 28800s (8h) and whose
# harbor override is 86400. 5.5 hours went unused, and the cells were ended by OUR cap
# rather than by the task. That is the same defect this repository already fixed once
# for `override_timeout_sec` ("a config value TIGHTER than the budget it claimed to
# defer to ... was what ended those trials"): the time budget was raised from 14400 to
# 28800 and this cap was not raised with it.
#
# 1200 is DERIVED, not chosen. The protocol needs ~185 gated turns as a floor -- 105
# probe rounds (21 x 5 stages, zero failures allowed) + 45 samples + ~35 reads/edits,
# none avoidable because stage k+1 stays locked until stage k passes -- and the step-5
# cells that SCORED on this task used 57-583 calls. 1200 gives ~6x the protocol floor,
# while harbor's wall clock remains the real bound.
export EF_LHTB_MAX_TURNS="${EF_LHTB_MAX_TURNS:-1200}"

# ## Verify the route in the transport that will actually use it
#
# This is the precondition the handoff used to state as a `curl`. That check is wrong in kind: it
# asked with a different transport than the one that runs.
#
# ## The old explanation for the failures was MEASURABLY FALSE (2026-10-16)
#
# It said `opencode.ai` resolves to nine A records, four refusing TCP 443, and that Node's fetch
# does not fall back across them as curl does. Measured:
#   * it resolves to FOUR A records (172.65.90.20-23, Cloudflare), and all four accept TCP 443;
#   * undici 7.28.0 never sets `autoSelectFamily`, so Node's default (true) applies and it DOES walk
#     the whole address set -- proven five ways, including an injected [dead, live] lookup returning
#     200 and an all-refuse set returning an AggregateError with one inner error per address.
# So "Node will not fall back" cannot explain those failures, and a comment asserting it is worse
# than no comment. What the preflight is FOR is unchanged: ask the question with the bridge's own
# transport, before Harbor pulls images.
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
# ## The external watchdog, started by the SHIPPED runner
#
# `eval/lhtb/watchdog.ts` samples the transcript mtime and `docker top` and reaps the host-side
# compose client tree with `taskkill /F /T`. That last part is not incidental: it is the ONLY thing
# that reaches the `docker-compose.exe` plugin, which survives its `docker.exe` parent and holds the
# stdout pipe open, wedging harbor's `communicate()` forever (docs/116).
#
# It already existed and did the right thing -- but it was started only by four ad-hoc launchers
# (ef-ucs.sh, ef-step5.sh, ef-sweep2.sh, ef-probe-foldwindow.sh), so the SHIPPED path had no
# host-side deadline at all (docs/117 section b). Measured consequence: five archived cells never
# finalised, one of them stuck 3h10m with no termination reason.
#
# Opt out with EF_LHTB_WATCHDOG=0.
# It REQUIRES EF_WATCH_JOBS: without it the watchdog cannot know what to watch, and before the
# guard added to watchdog.ts that turned into an infinite per-round throw. Eleven such processes
# were alive at once on 2026-10-16, and this runner was one of the things starting them.
WATCHDOG_PID=""
cleanup_watchdog() {
  if [ -n "$WATCHDOG_PID" ]; then
    kill "$WATCHDOG_PID" 2>/dev/null || true
    echo "watchdog: stopped pid=$WATCHDOG_PID"
  fi
}
trap cleanup_watchdog EXIT INT TERM
if [ "${EF_LHTB_WATCHDOG:-1}" = "1" ]; then
  EF_HOME_RESOLVED="${EF_HOME:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
  WATCHLOG="$EF_HOME_RESOLVED/ef-phase7-logs/watchdog.log"
  EF_WATCH_JOBS="${EF_WATCH_JOBS:-${LHTB_ROOT}/jobs}" \
  EF_WATCH_LOG="$WATCHLOG" \
  EF_WATCH_HEARTBEAT="$EF_HOME_RESOLVED/ef-phase7-logs/watchdog.heartbeat" \
  node --experimental-transform-types "${SCRIPT_DIR}/../eval/lhtb/watchdog.ts" >> "$WATCHLOG" 2>&1 &
  WATCHDOG_PID=$!
  echo "watchdog: pid=$WATCHDOG_PID jobs=${EF_WATCH_JOBS:-${LHTB_ROOT}/jobs} log=$WATCHLOG"
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
  # unknown-config only, on the RECALIBRATED 28800s budget. The plain sweep
  # config's override_timeout_sec (14400) would otherwise cap the task's own
  # budget back down to the number this round exists to fix.
  sweep-ucs) CONFIG_SRC="lhtb-ef-sweep-ucs.yaml" ;;
  # Gate E: one cell per task, to measure the turns it consumes before committing a
  # full sweep to it. The budget shortfall that produced an archive of zeros was
  # reconstructed AFTER the fact; this is the cheap way to know it first.
  calib)  CONFIG_SRC="lhtb-ef-calib.yaml" ;;
  calib-c0) CONFIG_SRC="lhtb-ef-calib-c0.yaml" ;;
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
