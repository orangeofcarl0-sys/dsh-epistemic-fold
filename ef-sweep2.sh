#!/usr/bin/env bash
# basic + economy only: ONE wave, 2 arms x n_attempts=3 = 6 cells, 4 concurrent.
#
# ## Why two arms and not four
#
# The question this wave answers is "does EF economy beat DSH Basic on the recalibrated
# unknown-config-semantics?", and `basic` is the only control that can answer it -- it
# mounts the REAL Basic engine with no EF surface, so a difference is attributable to the
# mode rather than to the fixture. balanced/quality answer a DIFFERENT question (what does
# the semantic-digest tier buy), and running them here would double the cells and the
# provider load without touching the question asked.
#
# ## COHORT BOUNDARY -- do not pool with anything earlier
#
# This wave runs a configuration no earlier cell ran:
#   EF_TAU2_WINDOW=131072   (F1; the diagnostic wave ran 32000 and thrashed 50-109 folds/cell)
#   EF_LHTB_MAX_TURNS=1200  (F3; the diagnostic wave ran 400 and ended every cell at ~2h31m)
#   override_timeout_sec=86400, force_build=true (lhtb-ef-sweep-ucs.yaml)
# It also runs against the PATCHED task harness (LHTB ccefd69, docs/64), so every earlier
# `unknown-config-semantics` cell -- which ran the fragile daemon -- is a different cohort
# for this task regardless of the EF settings.
set -uo pipefail
# EF_HOME from this script's own location: no machine path is baked in.
EF_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && { pwd -W 2>/dev/null || pwd; })"
. "$EF_HOME/scripts/ef-wave.sh"
LHTB_ROOT="${LHTB_ROOT:-$EF_HOME/../bench-workspace/lhtb}"
LOG="$EF_HOME/ef-phase7-logs/sweep2-run.log"
WATCHLOG="$EF_HOME/ef-phase7-logs/sweep2-watchdog.log"
WATCHHEART="$EF_HOME/ef-phase7-logs/sweep2-watchdog.heartbeat"
cd "$EF_HOME" || exit 1

echo "sweep2: start $(date +%H:%M:%S) | ef $(git rev-parse --short HEAD) | lhtb $(git -C "$LHTB_ROOT" rev-parse --short HEAD)" | tee -a "$LOG"
echo "sweep2: model=$EF_LIVE_MODEL window=${EF_TAU2_WINDOW:-derived-by-run-lhtb} maxTurns=${EF_LHTB_MAX_TURNS:-1200} tiers=basic,economy n=3 arms=2 cells=6 concurrent=4" | tee -a "$LOG"
: > "$WATCHLOG"
# Only OUR containers: the shared host runs other lines, and an unfiltered docker rm once
# deleted a sibling lane's running cell (see ef-ucs.sh).
ORPHANS=$(docker ps -aq --filter "name=unknown-config-semantics" | wc -l)
if [ "$ORPHANS" != "0" ]; then
  echo "sweep2: removing $ORPHANS orphan(s) of our own" | tee -a "$LOG"
  docker ps -aq --filter "name=unknown-config-semantics" | xargs -r docker rm -f >/dev/null 2>&1
fi

# The watchdog starts BEFORE the cells so a wedge in the first minutes is caught.
EF_WATCH_JOBS="$LHTB_ROOT/jobs" EF_WATCH_LOG="$WATCHLOG" EF_WATCH_HEARTBEAT="$WATCHHEART" \
  node --experimental-transform-types "$EF_HOME/eval/lhtb/watchdog.ts" >> "$WATCHLOG" 2>&1 &
echo "sweep2: watchdog pid=$!" | tee -a "$LOG"

PIDS=()
ef_wave_launch sweep2 sweep-ucs 5 "" basic economy

FAIL=0
for PID in "${PIDS[@]}"; do wait "$PID" || FAIL=1; done
echo "sweep2: ALL DONE at $(date +%H:%M:%S) fail=$FAIL" | tee -a "$LOG"
docker ps -q | wc -l
exit $FAIL
