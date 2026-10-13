# The shared sweep-wave body: one ef-phase7.sh launch per arm, in parallel.
#
# ## Why this file
#
# Nine drivers carried the same launch loop with different arms, modes, sleeps and
# log labels: ef-round2.sh, ef-round2b.sh, ef-round3.sh, ef-round3b.sh,
# ef-round3c.sh, ef-rounds456.sh, ef-four-parallel.sh, ef-step5.sh, ef-ucs.sh.
# The loop is the part that must not drift -- it is what puts EF_LHTB_ARM into the
# child and what the caller's wait loop then waits on.
#
# ## Why it is SOURCED rather than executed
#
# The children must stay children of the DRIVER's shell: every caller does
# `wait "$PID"` and reports each exit code, and ef-round2b.sh / ef-round3*.sh
# read the live PID list from a heartbeat. A separate process would own the
# children and the driver's wait would return at once. Same reason
# scripts/proxy-env.sh is sourced.
#
# ## What stays with the caller
#
# The label (its log prefix), the arms, the mode, the inter-launch sleep, the
# heartbeat/watchdog, and the wait/summary lines -- those differ per driver and are
# that driver's record rather than the shared body.
#
# Sourced, never executed.

# ef_wave_launch <label> <mode> <nap-seconds> <note> <arm>...
#   APPENDS one background launcher per arm to the caller's PIDS array, so a driver
#   that launches several waves before waiting resets PIDS once, before its first
#   call, exactly as the inline loop did. The caller supplies LOG; each child's
#   output is appended to it.
#   An EMPTY label suppresses the per-arm line (ef-rounds456.sh's inner loop prints
#   none). note is appended to the arm name in that line (ef-round2.sh prints
#   "basic run 1").
ef_wave_launch() {
  local label="$1" mode="$2" nap="$3" note="$4"
  shift 4
  local arm
  for arm in "$@"; do
    if [ -n "$label" ]; then
      echo "${label}: launching ${arm}${note} at $(date +%H:%M:%S)" | tee -a "$LOG"
    fi
    # LHTB_ROOT is passed even when empty: ef-phase7.sh reads it as
    # ${LHTB_ROOT:-<default>}, so a driver that never set it keeps the same
    # default, and ef-ucs.sh / ef-step5.sh keep the root they resolved.
    EF_HOME="$EF_HOME" LHTB_ROOT="${LHTB_ROOT:-}" EF_LHTB_ARM="$arm" \
      bash "$EF_HOME/ef-phase7.sh" "$mode" >> "$LOG" 2>&1 &
    PIDS+=($!)
    sleep "$nap"
  done
}
