#!/usr/bin/env bash
# Wait out an upstream outage, then relaunch the wave.
#
# The provider answers in 2-3s with HTTP 429 "Endpoint is unavailable", so the outage
# is detectable cheaply and the cells do not have to be run into it. Measured with
# every cell stopped, so this is the endpoint's state, not our concurrency.
#
# The probe uses the SAME route the harness does (the proxy, the store's key, and the
# x-opencode-session header the endpoint requires) -- a probe that omits the header
# gets a fast 400 and would read as "the endpoint is fine" while every real request
# fails.
set -uo pipefail
EF_HOME="D:/Data and code/xuchengjian/workplace/dsh-epistemic-fold"
LOG="$EF_HOME/ef-phase7-logs/wait-provider.log"
CRED=$(echo "$USERPROFILE/.dsh/.credentials.yaml" | sed 's|\\|/|g')
KEY=$(grep -m1 'OPENCODE_GO_API_KEY' "$CRED" | sed 's/.*: *//' | tr -d '"' | tr -d '\r')
echo "wait-provider: start $(date +%H:%M:%S)" | tee -a "$LOG"
for i in $(seq 1 240); do
  SID="wait-$RANDOM$RANDOM"
  code=$(curl.exe -s -o /tmp/wp.txt -w '%{http_code}' --max-time 45 --noproxy '*' -x http://127.0.0.1:7890 \
    -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H "x-opencode-session: $SID" \
    -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"ok"}],"stream":false}' \
    https://opencode.ai/zen/go/v1/chat/completions 2>/dev/null)
  if [ "$code" = "200" ]; then
    echo "wait-provider: RECOVERED at $(date +%H:%M:%S) after $i probes" | tee -a "$LOG"
    cd "$EF_HOME" || exit 1
    bash "$EF_HOME/ef-rerun-a.sh"
    exit 0
  fi
  [ $((i % 5)) -eq 0 ] && echo "  probe $i: HTTP $code at $(date +%H:%M:%S)" >> "$LOG"
  sleep 150
done
echo "wait-provider: gave up after 240 probes at $(date +%H:%M:%S)" | tee -a "$LOG"
