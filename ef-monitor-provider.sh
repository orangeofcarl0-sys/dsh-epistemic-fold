#!/usr/bin/env bash
# Watch the endpoint and log when it recovers. RELAUNCHES NOTHING.
#
# ef-wait-provider.sh relaunches a wave on recovery, which is right when the cells have died. It
# is wrong here: the eight running cells have their own outage ceiling (PROVIDER_OUTAGE_MAX_SEC,
# two hours) and resume by themselves the moment a call succeeds, so a relaunch would double the
# load on an endpoint that is already answering 429.
#
# The probe uses the SAME route the harness does -- the proxy, the store's key, and the
# x-opencode-session header. A probe that omits the header gets a fast 400 and reads as "the
# endpoint is fine" while every real request fails, which is a mistake already made once tonight.
set -uo pipefail
# EF_HOME from this script's own location: no machine path is baked in. `pwd -W`
# reproduces the Windows form the removed literal had, and falls back to `pwd`.
EF_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && { pwd -W 2>/dev/null || pwd; })"
LOG="$EF_HOME/ef-phase7-logs/monitor-provider.log"
CRED=$(echo "$USERPROFILE/.dsh/.credentials.yaml" | sed 's|\\|/|g')
KEY=$(grep -m1 'OPENCODE_GO_API_KEY' "$CRED" | sed 's/.*: *//' | tr -d '"' | tr -d '\r')
echo "monitor: start $(date +%H:%M:%S)" >> "$LOG"
for i in $(seq 1 400); do
  code=$(curl.exe -s -o /tmp/mp.txt -w '%{http_code}' --max-time 45 --noproxy '*' -x http://127.0.0.1:7890 \
    -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H "x-opencode-session: mon-$RANDOM$RANDOM" \
    -d '{"model":"step-5-preview-free","messages":[{"role":"user","content":"ok"}],"stream":false}' \
    https://opencode.ai/zen/go/v1/chat/completions 2>/dev/null)
  echo "  probe $i: HTTP $code at $(date +%H:%M:%S)" >> "$LOG"
  if [ "$code" = "200" ]; then
    echo "monitor: RECOVERED at $(date +%H:%M:%S) after $i probes" | tee -a "$LOG"
    exit 0
  fi
  sleep 120
done
echo "monitor: still down after 400 probes at $(date +%H:%M:%S)" | tee -a "$LOG"
