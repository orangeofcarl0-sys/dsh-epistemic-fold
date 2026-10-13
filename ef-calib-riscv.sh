#!/usr/bin/env bash
# Gate E calibration for riscv-core-debug: ONE cell.
#
# The only question this answers is "how many model turns does this task consume, and
# does that fit the 21600s it declares". unknown-config was launched on 8 cells x 4h
# first and the -70% shortfall was reconstructed afterwards; this is the cheap way.
set -uo pipefail
# EF_HOME from this script's own location: no machine path is baked in. `pwd -W`
# reproduces the Windows form the removed literal had, and falls back to `pwd`.
EF_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && { pwd -W 2>/dev/null || pwd; })"
LHTB_ROOT="${LHTB_ROOT:-D:\Data and code\xuchengjian\workplace\bench-workspace\lhtb}"
LOG="$EF_HOME/ef-phase7-logs/calib-riscv.log"
cd "$EF_HOME" || exit 1
echo "calib: start $(date +%H:%M:%S)" | tee -a "$LOG"
docker ps -aq --filter "name=riscv-core-debug"
# ## Why the preflight is skipped, and why that is not a shortcut
#
# It aborts the run in two seconds with "the BRIDGE cannot reach the provider", yet a
# direct node fetch to the same endpoint returns HTTP 200. The preflight also refuses
# when a proxy is configured in the environment that Node is not using -- a warning
# about configuration rather than a measurement of the route. Its own message offers
# this flag. The route was verified by hand immediately before this launch; if it is
# down, the cells will show providerFailures and the run ends as an infrastructure
# fact rather than a silent one.
EF_HOME="$EF_HOME" LHTB_ROOT="$LHTB_ROOT" EF_LHTB_ARM=basic EF_SKIP_ROUTE_CHECK=1 \
  bash "$EF_HOME/ef-phase7.sh" calib >> "$LOG" 2>&1
echo "calib: done $(date +%H:%M:%S) exit=$?" | tee -a "$LOG"
