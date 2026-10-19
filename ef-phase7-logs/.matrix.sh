#!/usr/bin/env bash
# Run the NEW-DESIGN memory matrix: every tier x every arm x n reps.
#
# The design under test:
#   - a tier's corpus is fixed and NON-REGENERABLE
#   - it arrives in N equal parts (6 for 131k/252k/475k, 7 for 1m -- resolved per tier by
#     run_cell.py, so no --depth is passed here)
#   - one fold is driven after each part, and the engine never folds on its own
#   - the REGENERABLE arm receives no corpus: its documents sit in the filesystem and the model
#     reads them through DSH's read tool for as many turns as it needs
#
# The regenerable arm runs PER TIER because the corpora differ in size -- 553K tokens at 131k
# against 4.4M at 1m -- so the reading workload differs even though the mechanism does not.
set -uo pipefail

EF_HOME="${EF_HOME:-D:/Data and code/xuchengjian/workplace/dsh-epistemic-fold}"
cd "$EF_HOME" || exit 1

OUT="${OUT:-ef-phase7-logs/matrix}"
TIERS="${TIERS:-131072 258048 475136 1048576}"
ARMS="${ARMS:-basic economy balanced quality regen}"
REPS="${REPS:-5}"
PAR="${PAR:-2}"
CELL_TIMEOUT="${CELL_TIMEOUT:-7200}"
export EF_BRIDGE_MAX_TOKENS="${EF_BRIDGE_MAX_TOKENS:-32768}"

mkdir -p "$OUT"

tier_dir() {
  case "$1" in
    131072) echo 131k ;;
    258048) echo 252k ;;
    475136) echo 475k ;;
    1048576) echo 1m ;;
    *) echo "" ;;
  esac
}

run_cell() {
  local tier="$1" arm="$2" rep="$3"
  local td; td=$(tier_dir "$tier")
  local out="$OUT/${td}/${arm}-${rep}.json"
  local log="$OUT/${td}/${arm}-${rep}.log"
  [ -f "$out" ] && return 0          # resumable: an existing cell is not re-paid for
  mkdir -p "$OUT/$td"
  local mode="A"
  local extra=()
  if [ "$arm" = "regen" ]; then
    mode="R"
    extra=(--fs-root "eval/memory/corpora/$td")
  fi
  EF_MEMORY_WINDOW="$tier" EF_TAU2_WINDOW="$tier" \
  EF_BRIDGE_STDERR="$OUT/$td/$arm-$rep.stderr.log" \
    timeout -k 10 "$CELL_TIMEOUT" bash eval/memory/run-memory.sh \
      --mode "$mode" --arm "$arm" --order logical --out "$out" \
      ${extra[@]+"${extra[@]}"} > "$log" 2>&1
  local rc=$?
  if [ "$rc" -eq 3 ]; then
    echo "TERMINAL provider error in $td/$arm-$rep -- stopping the sweep" >&2
    touch "$OUT/STOP"
  elif [ "$rc" -ne 0 ]; then
    echo "cell $td/$arm-$rep exited $rc (see $log)" >&2
  fi
  return 0
}

if [ -f "$OUT/STOP" ]; then echo "STOP file present from an earlier sweep; remove it to resume" >&2; exit 3; fi

for tier in $TIERS; do
  for arm in $ARMS; do
    for rep in $(seq 1 "$REPS"); do
      [ -f "$OUT/STOP" ] && { echo "stopping: terminal provider error" >&2; exit 3; }
      run_cell "$tier" "$arm" "$rep" &
      while [ "$(jobs -rp | wc -l)" -ge "$PAR" ]; do wait -n; done
    done
  done
  echo "tier $tier dispatched"
done
wait
echo "matrix complete: $OUT"