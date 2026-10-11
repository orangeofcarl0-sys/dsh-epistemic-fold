#!/usr/bin/env bash
# Phase 7 driver (temporary, untracked).
#
# Why a file and not `bash -c`: PowerShell splits a native-command argument on
# spaces, so a root that contains one cannot be passed inline there. LHTB_ROOT is
# taken from the environment, defaulting to the LHTB checkout beside this repo.
#
# Usage: EF_HOME=<repo> [EF_LHTB_ARM=<arm>] bash ef-phase7.sh <probe|sweep|oracle>
#
# Three environment facts this host needs, each measured rather than assumed:
#
#   EF_USE_PROXY=1   opencode.ai publishes a partial A-record set (4 of 9 refuse
#                    TCP 443). curl falls back across it and looks healthy; Node's
#                    fetch does not, and the EF bridge is Node. Measured: direct
#                    0/10, via proxy 5/5. Handoff 2.1's precondition, satisfied.
#
#   the go route     `space-bunny-free` on /zen/v1 now answers 429
#                    FreeUsageLimitError, and the other five `-free` models answer
#                    403 FreeTierError ("free tier can only be used from within
#                    OpenCode"), so none of them is a substitute. LongCat lives on
#                    /zen/go/v1, which requires an `x-opencode-session` header;
#                    scripts/run-lhtb.sh derives it from the base URL.
#
#   EF_TAU2_FOLD_TIMEOUT_MS  a fold used to be unbounded (AbortController created
#                    and never aborted); the default bound is 600s and is left alone.
set -uo pipefail

MODE="${1:?usage: ef-phase7.sh <probe|sweep|oracle>}"
EF_HOME="${EF_HOME:?set EF_HOME to the EF repo}"
export LHTB_ROOT="${LHTB_ROOT:-$EF_HOME/../bench-workspace/lhtb}"
# ## The proxy is OFF by default, because it is now the least reliable hop
#
# It used to be ON, on a measurement that no longer holds: "direct 0/10, via proxy
# 5/5", taken when opencode.ai's A-record set was partial and Node's fetch would not
# fall back across it. That is a DNS condition, not a permanent property, and it has
# changed.
#
# Measured now, at the SAME 8-way concurrency the sweep runs at:
#
#   direct   24/24 ok, 2.4-3.6s per 8-call round
#   proxy    the transport behind a total outage -- five of eight cells recorded
#            55-61 CONSECUTIVE "fetch failed" turns and died of it
#
# That reading was taken while port 10808 was DEAD, and it blamed the mechanism when
# the evidence only supported a conclusion about the address. Remeasured on 20
# sequential realistic requests, within the same minute, on each route:
#
#   direct   0 ok, 20x "fetch failed"    -- completely down
#   proxy    6 ok, 14x HTTP 429          -- degraded but WORKING
#
# Direct is not the good route; it is one that periodically dies outright, while the
# proxy degrades instead. The port is now DISCOVERED at run time (scripts/run-lhtb.sh)
# rather than assumed, so a proxy that moved is found instead of silently looking like
# one that is broken -- which is exactly how the earlier conclusion was reached.
export EF_USE_PROXY="${EF_USE_PROXY:-1}"
export EF_LIVE_BASE_URL="${EF_LIVE_BASE_URL:-https://opencode.ai/zen/go/v1}"
# The name was read off the route's own model list rather than guessed: /zen/go/v1
# serves 38 models and an unknown one answers `Model is unavailable`, so a typo
# here fails loudly instead of silently measuring something else.
export EF_LIVE_MODEL="${EF_LIVE_MODEL:-step-5-preview-free}"

[ -d "$LHTB_ROOT" ] || { echo "driver: LHTB_ROOT=$LHTB_ROOT is not a directory; set LHTB_ROOT to the LHTB checkout" >&2; exit 1; }
cd "$EF_HOME" || exit 1

LOG_DIR="$EF_HOME/ef-phase7-logs"
mkdir -p "$LOG_DIR"
ARM="${EF_LHTB_ARM:-basic}"
TS="$(date +%Y%m%d-%H%M%S)"
LOG="$LOG_DIR/${TS}-${MODE}-${ARM}.log"
export EF_LHTB_ARM="$ARM"

echo "driver: mode=$MODE arm=$ARM proxy=$EF_USE_PROXY model=$EF_LIVE_MODEL"
echo "driver: log=$LOG"
bash scripts/run-lhtb.sh "$MODE" > >(tee "$LOG") 2>&1
echo "driver: exit=$? log=$LOG"
