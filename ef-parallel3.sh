#!/usr/bin/env bash
# Relaunch unknown-config and commit0 -- destroyed at 04:06 when restarting riscv ran an
# UNSCOPED container sweep in its own driver. That sweep is now scoped to riscv-core-debug
# in ef-calib-riscv.sh, so this recovery cannot repeat it.
set -uo pipefail
EF_HOME="D:\Data and code\xuchengjian\workplace\dsh-epistemic-fold"
LHTB_ROOT="${LHTB_ROOT:-D:\Data and code\xuchengjian\workplace\bench-workspace\lhtb}"
LOG="$EF_HOME/ef-phase7-logs/parallel-wave3.log"
cd "$EF_HOME" || exit 1
echo "=== wave3 recovering the killed lines at $(date +%H:%M:%S) ===" | tee -a "$LOG"
( EF_HOME="$EF_HOME" LHTB_ROOT="$LHTB_ROOT" bash "$EF_HOME/ef-ucs.sh" \
    > "$EF_HOME/ef-phase7-logs/wave3-ucs.log" 2>&1 ; echo "ucs done rc=$?" >> "$LOG" ) &
A=$!
( EF_HOME="$EF_HOME" LHTB_ROOT="$LHTB_ROOT" bash "$EF_HOME/ef-calib-commit0.sh" \
    > "$EF_HOME/ef-phase7-logs/wave3-c0.log" 2>&1 ; echo "commit0 done rc=$?" >> "$LOG" ) &
B=$!
echo "line A pid=$A line B pid=$B" | tee -a "$LOG"
wait $A $B
echo "=== wave3 finished at $(date +%H:%M:%S) ===" | tee -a "$LOG"
