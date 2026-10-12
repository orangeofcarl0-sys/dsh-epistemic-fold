#!/usr/bin/env bash
# Fresh run on step-5-preview-free, with every harness defect this round exposed
# FIXED and launched together, so the round measures the tasks rather than the rig:
#
#   1. RC29 truncation retry  -- a summarization cut off at the cap is retried
#   2. reply budget 32768     -- a reasoning model was spending 8192 entirely on
#                                reasoning and answering with NOTHING (five
#                                consecutive empty max-tokens replies ended a cell)
#   3. truncation escalation  -- an empty max-tokens reply is now a TRUNCATION with
#                                a bigger budget, not an "empty response" to nudge
#   4. watchdog               -- reaps a tool process the 900s timeout failed to
#                                kill, which is what wedged two cells for 1h35m/3h10m
#
# TIER LADDER, upper half: balanced (retention first) vs quality (retention + a
# rationale checkpoint per fold). basic vs economy was the previous wave; these two
# are the remaining rungs, so all four tiers are then measured on one harness.
#
# 8 concurrent cells: two sweeps (balanced, quality) x (2 tasks x n_attempts=2) in ONE
# wave. 8 is the largest MEASURED point that does not make the route queue; at 32
# the latency rose 6.6x for 4x the concurrency and total throughput FELL.
set -uo pipefail
EF_HOME="D:/Data and code/xuchengjian/workplace/dsh-epistemic-fold"
LHTB_ROOT="${LHTB_ROOT:-$EF_HOME/../bench-workspace/lhtb}"
LOG="$EF_HOME/ef-phase7-logs/step5e-run.log"
HEART="$EF_HOME/ef-phase7-logs/step5e-run.heartbeat"
WATCHLOG="$EF_HOME/ef-phase7-logs/step5e-watchdog.log"
WATCHHEART="$EF_HOME/ef-phase7-logs/step5e-watchdog.heartbeat"
cd "$EF_HOME" || exit 1
echo "step5e: start $(date +%H:%M:%S) | ef $(git rev-parse --short HEAD) | lhtb $(git -C "$LHTB_ROOT" rev-parse --short HEAD)" | tee -a "$LOG"
echo "step5e: model=${EF_LIVE_MODEL:-step-5-preview-free} reply_budget=${EF_BRIDGE_MAX_TOKENS:-32768} summary_budget=${EF_TAU2_SUMMARY_MAX_TOKENS:-32768} summary_retry=${EF_SUMMARY_RETRY_ATTEMPTS:-2} trunc_streak=${EF_LHTB_MAX_TRUNCATED:-3} watch=${EF_WATCH_INTERVAL_SEC:-60}s" | tee -a "$LOG"
: > "$WATCHLOG"
ORPHANS=$(docker ps -aq | wc -l)
if [ "$ORPHANS" != "0" ]; then echo "step5e: removing $ORPHANS orphan(s)" | tee -a "$LOG"; docker ps -aq | xargs -r docker rm -f >/dev/null 2>&1; fi

# The watchdog starts BEFORE the cells so a wedge in the first minutes is caught.
EF_WATCH_JOBS="$LHTB_ROOT/jobs" EF_WATCH_LOG="$WATCHLOG" EF_WATCH_HEARTBEAT="$WATCHHEART" \
  node --experimental-transform-types "$EF_HOME/eval/lhtb/watchdog.ts" >> "$WATCHLOG" 2>&1 &
WPID=$!
echo "step5e: watchdog pid=$WPID log=$WATCHLOG" | tee -a "$LOG"

PIDS=()
for ARM in balanced quality; do
  echo "step5e: launching $ARM at $(date +%H:%M:%S)" | tee -a "$LOG"
  EF_HOME="$EF_HOME" LHTB_ROOT="$LHTB_ROOT" EF_LHTB_ARM="$ARM" bash "$EF_HOME/ef-phase7.sh" sweep >> "$LOG" 2>&1 &
  PIDS+=($!)
  sleep 25
done
echo "step5e: 2 sweeps = 8 concurrent cells" | tee -a "$LOG"
(
  while true; do
    # Liveness from the watchdog's OWN heartbeat, not from \$WPID: replacing the
    # watchdog (which happened three times) left this reporting "down" for a
    # watchdog that was running, i.e. a log naming the wrong thing.
    if [ -n "$(find "$WATCHHEART" -mmin -3 2>/dev/null)" ]; then WSTATE=up; else WSTATE=down; fi
    echo "$(date +%H:%M:%S) pids=${PIDS[*]} containers=$(docker ps -q | wc -l) watchdog=$WSTATE" > "$HEART"
    sleep 60
  done
) &
HP=$!
for PID in "${PIDS[@]}"; do
  wait "$PID"; echo "step5e: pid $PID rc=$? at $(date +%H:%M:%S)" | tee -a "$LOG"
done
kill "$HP" 2>/dev/null
kill "$WPID" 2>/dev/null
echo "step5e: ALL DONE at $(date +%H:%M:%S)" | tee -a "$LOG"
