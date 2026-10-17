#!/usr/bin/env bash
# ## Re-run until every cell produces a real implementation
#
# Measured 2026-10-17: 14 of 28 cells finished at `best_correct_fields = 256`, the verifier's value
# for an implementation that changed nothing. Eight cells that consumed an IDENTICAL sample budget
# (17/45) split across 256-585 fields, so the outcome is not a function of how much was sampled.
# Re-running is therefore the only repair available for a genuinely random process.
#
# Two defects in the first version, both fixed here and both worth naming:
#
#   1. It matched job directories on its OWN timestamp. The runner generates its own, three seconds
#      later, so the glob matched nothing, the count was 0, and it declared ALL NORMAL after one
#      round that had in fact produced eight baselines. **A check that cannot fail is not a check.**
#      Now the directories are found by DIFFING the jobs tree before and after the round.
#
#   2. It ran while the route was returning 429, and recorded the resulting baselines as results.
#      Four earlier baseline cells are already known to have been rate-limit artefacts. **Running
#      against a refusing provider writes noise into the archive.** Now every round begins with a
#      live probe and waits for a 200 before spending anything.
set -u
EF_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JOBS="${LHTB_ROOT}/jobs"
MAX_ROUNDS="${MAX_ROUNDS:-12}"
ATTEMPTS="${ATTEMPTS:-2}"
LOGDIR="$EF_HOME/ef-phase7-logs/rerun"
mkdir -p "$LOGDIR"

# A live probe, not a cached verdict: the route recovered once already during this session.
route_ok() {
  node "$EF_HOME/scripts/probe-route.mjs" >/dev/null 2>&1
}
snapshot_dirs() { ls -1 "$JOBS" 2>/dev/null | grep 'sweep-ucs' || true; }

# Counting is done in Node (scripts/count-baselines.mjs): the shell version embedded a quote inside
# `"$(sed -n '..."...' ...)"` and bash rejected the entire script.
round=0
while [ "$round" -lt "$MAX_ROUNDS" ]; do
  round=$((round+1))
  echo "=== round $round/$MAX_ROUNDS ==="
  # Wait for a working route before spending a single call.
  for attempt in $(seq 1 60); do
    if route_ok; then echo "  route: 200 OK"; break; fi
    echo "  route: not serving (attempt $attempt/60), waiting 300s"
    sleep 300
  done
  if ! route_ok; then echo "  ABORT: route never recovered; not writing noise"; exit 2; fi
  before="$(snapshot_dirs)"
  for arm in basic economy balanced quality; do
    EF_LHTB_ARM="$arm" EF_LHTB_ATTEMPTS="$ATTEMPTS" \
      bash "$EF_HOME/scripts/run-lhtb.sh" sweep-ucs > "$LOGDIR/r${round}-${arm}.log" 2>&1 &
  done
  sleep 25
  # Barrier on the ARTIFACT: a round is over when its cells have rewards and nothing is running.
  waited=0
  while [ "$waited" -lt 21600 ]; do
    pending=0
    for d in $(comm -13 <(echo "$before" | sort) <(snapshot_dirs | sort)); do
      while IFS= read -r t; do
        [ -n "$t" ] || continue
        [ -f "$(dirname "$t")/verifier/reward.json" ] || pending=$((pending+1))
      done < <(find "$JOBS/$d" -name ef-transcript.json 2>/dev/null)
    done
    running="$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')"
    [ "$pending" = "0" ] && [ "$running" = "0" ] && break
    sleep 60; waited=$((waited+60))
  done
  echo "  barrier released after ${waited}s (pending=$pending running=$running)"
  newdirs="$(comm -13 <(echo "$before" | sort) <(snapshot_dirs | sort))"
  echo "  this round's job dirs: $(echo $newdirs | wc -w)"
  bad=0
  if [ -n "$newdirs" ]; then
    bad="$(node "$EF_HOME/scripts/count-baselines.mjs" "$JOBS" $newdirs | sed -n 's/.*"bad":\([0-9]*\).*/\1/p')"
    bad="${bad:-0}"
  fi
  echo "  cells baseline or missing = $bad"
  if [ "$bad" = "0" ]; then echo "ALL NORMAL after $round rounds"; exit 0; fi
done
echo "NOT CONVERGED after $MAX_ROUNDS rounds -- reporting rather than hiding"
exit 1