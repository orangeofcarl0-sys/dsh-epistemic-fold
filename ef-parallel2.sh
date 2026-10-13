#!/usr/bin/env bash
# Relaunch the TWO lines that were running stale pre-fix images. riscv is already up and
# is untouched: its June image is fine because its only change was task.toml (the artifacts
# path), which harbor reads from the task source at run time rather than from the image.
set -uo pipefail
# EF_HOME from this script's own location: no machine path is baked in. `pwd -W`
# reproduces the Windows form the removed literal had, and falls back to `pwd`.
EF_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && { pwd -W 2>/dev/null || pwd; })"
LHTB_ROOT="${LHTB_ROOT:-D:\Data and code\xuchengjian\workplace\bench-workspace\lhtb}"
LOG="$EF_HOME/ef-phase7-logs/parallel-wave2.log"
cd "$EF_HOME" || exit 1
echo "=== wave2 relaunching at $(date +%H:%M:%S) ===" | tee -a "$LOG"
( EF_HOME="$EF_HOME" LHTB_ROOT="$LHTB_ROOT" bash "$EF_HOME/ef-ucs.sh" \
    > "$EF_HOME/ef-phase7-logs/wave2-ucs.log" 2>&1 ; echo "ucs done rc=$?" >> "$LOG" ) &
A=$!
( EF_HOME="$EF_HOME" LHTB_ROOT="$LHTB_ROOT" bash "$EF_HOME/ef-calib-commit0.sh" \
    > "$EF_HOME/ef-phase7-logs/wave2-c0.log" 2>&1 ; echo "commit0 done rc=$?" >> "$LOG" ) &
B=$!
echo "line A pid=$A line B pid=$B (riscv already running)" | tee -a "$LOG"
wait $A $B
echo "=== wave2 finished at $(date +%H:%M:%S) ===" | tee -a "$LOG"
