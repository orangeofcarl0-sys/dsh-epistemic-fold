#!/usr/bin/env bash
# Phase 7 driver (temporary, untracked).
#
# Why a file and not `bash -c`: PowerShell splits a native-command argument on
# spaces, so LHTB_ROOT="/d/Data and code/..." loses everything after /d/Data.
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
export LHTB_ROOT="/d/Data and code/xuchengjian/workplace/bench-workspace/lhtb"
export EF_USE_PROXY="${EF_USE_PROXY:-1}"
export EF_LIVE_BASE_URL="${EF_LIVE_BASE_URL:-https://opencode.ai/zen/go/v1}"
# The name was read off the route's own model list rather than guessed: /zen/go/v1
# serves 38 models and an unknown one answers `Model is unavailable`, so a typo
# here fails loudly instead of silently measuring something else.
export EF_LIVE_MODEL="${EF_LIVE_MODEL:-step-5-preview-free}"

[ -d "$LHTB_ROOT" ] || { echo "driver: LHTB_ROOT missing" >&2; exit 1; }
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
