#!/usr/bin/env bash
# Full four-tier run of the RECALIBRATED unknown-config-semantics.
#
# ## What changed since step5, and why this round exists
#
#   1. THE ORACLE IS GONE. The probe pool was bare sha256 over small integers and
#      all 847 entries were brute-forceable; the best archived run scored 0.8894
#      with ZERO probes, straight off that file. cfgd_secret.json is now read into
#      the daemon and unlinked by the image ENTRYPOINT before the agent exists.
#   2. THE BUDGET FITS THE PROTOCOL. 14400s bought 109 model turns (measured: 132s
#      per call, 32 of 70 archived runs timed out); the protocol needs ~185. Now
#      28800s, and the sweep config's override_timeout_sec matches it exactly --
#      a config tighter than the task budget is what ended trials before.
#   3. A ZERO IS EXPLAINABLE. reward.json now carries live_engine_ungated, so a 0
#      says what the engine achieved instead of only that nothing was submitted.
#
# ## Why four arms at once is right here
#
# Each arm job is 1 task x n_attempts=2 = 2 cells, so four arms are 8 concurrent
# cells -- exactly the largest MEASURED point that does not make the route queue.
# Under one wave the arms share the provider's conditions, which is the point.
set -uo pipefail
EF_HOME="D:/Data and code/xuchengjian/workplace/dsh-epistemic-fold"
LHTB_ROOT="${LHTB_ROOT:-$EF_HOME/../bench-workspace/lhtb}"
LOG="$EF_HOME/ef-phase7-logs/ucs-run.log"
WATCHLOG="$EF_HOME/ef-phase7-logs/ucs-watchdog.log"
WATCHHEART="$EF_HOME/ef-phase7-logs/ucs-watchdog.heartbeat"
cd "$EF_HOME" || exit 1

echo "ucs: start $(date +%H:%M:%S) | ef $(git rev-parse --short HEAD) | lhtb $(git -C "$LHTB_ROOT" rev-parse --short HEAD)" | tee -a "$LOG"
echo "ucs: model=${EF_LIVE_MODEL:-step-5-preview-free} budget=28800s tiers=basic,economy,balanced,quality cells=8" | tee -a "$LOG"
: > "$WATCHLOG"
# ## Only OUR containers
#
# This was `docker ps -aq | xargs docker rm -f` -- every container on the host. Running
# the four tiers in parallel with the other lines therefore deleted commit0's running
# cell, and from the outside that looked like an unexplained crash rather than one line
# killing another. Filtered to our own task.
ORPHANS=$(docker ps -aq --filter "name=unknown-config-semantics" | wc -l)
if [ "$ORPHANS" != "0" ]; then
  echo "ucs: removing $ORPHANS orphan(s) of our own" | tee -a "$LOG"
  docker ps -aq --filter "name=unknown-config-semantics" | xargs -r docker rm -f >/dev/null 2>&1
fi

# The watchdog starts BEFORE the cells so a wedge in the first minutes is caught.
EF_WATCH_JOBS="$LHTB_ROOT/jobs" EF_WATCH_LOG="$WATCHLOG" EF_WATCH_HEARTBEAT="$WATCHHEART" \
  node --experimental-transform-types "$EF_HOME/eval/lhtb/watchdog.ts" >> "$WATCHLOG" 2>&1 &
echo "ucs: watchdog pid=$!" | tee -a "$LOG"

PIDS=()
for ARM in basic economy balanced quality; do
  echo "ucs: launching $ARM at $(date +%H:%M:%S)" | tee -a "$LOG"
  EF_HOME="$EF_HOME" LHTB_ROOT="$LHTB_ROOT" EF_LHTB_ARM="$ARM" \
    bash "$EF_HOME/ef-phase7.sh" sweep-ucs >> "$LOG" 2>&1 &
  PIDS+=($!)
  sleep 5
done

FAIL=0
for PID in "${PIDS[@]}"; do wait "$PID" || FAIL=1; done
echo "ucs: ALL DONE at $(date +%H:%M:%S) fail=$FAIL" | tee -a "$LOG"
docker ps -q | wc -l
exit $FAIL
