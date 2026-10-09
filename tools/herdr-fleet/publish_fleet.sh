#!/bin/zsh
# publish_fleet.sh — HK5 (herdr-lead order 08 Oct): run fleetboard.py --json,
# scp to e2e-lab, upload to R2 (bucket eta-lab-results, key lanes/_fleet.json)
# with the box's existing Cloudflare token the way reb/r2_mirror.py does
# (token from its 0600 file, into the wrangler subprocess env only — never
# argv, never logged). One log line per run.
set -u
DIR="/Users/vinaybhardwaj/dev/_fable/herdr/fleetboard"
JSON="/tmp/_fleet.json"
LOG="$DIR/publish.log"
STAMP=$(date +%Y-%m-%dT%H:%M:%S%z)

python3 "$DIR/fleetboard.py" --json "$JSON" >> "$LOG" 2>&1
if [ $? -ne 0 ]; then
  echo "$STAMP FAILED collect" >> "$LOG"; exit 1
fi

scp -o BatchMode=yes "$JSON" e2e-lab:/home/eta/oc/fleet-json/_fleet.json >> "$LOG" 2>&1
if [ $? -ne 0 ]; then
  echo "$STAMP FAILED scp" >> "$LOG"; exit 1
fi

# Upload on the box: wrangler with the box's Cloudflare token from its 0600 file
ssh -o BatchMode=yes e2e-lab '
  TOKEN=$(cat /home/eta/.claude/secrets/cloudflare_api_token 2>/dev/null)
  if [ -z "$TOKEN" ]; then echo "no-token"; exit 2; fi
  CLOUDFLARE_API_TOKEN="$TOKEN" npx wrangler r2 object put eta-lab-results/lanes/_fleet.json --remote --file ~/oc/fleet-json/_fleet.json --content-type application/json 2>&1 | tail -1
' >> "$LOG" 2>&1
rc=$?
if [ $rc -ne 0 ]; then
  echo "$STAMP FAILED r2-put rc=$rc" >> "$LOG"; exit 1
fi
# HK6: fetch each registered Sarvam caller's lane file (sarvam-<caller>.json)
# from R2, to a temp name then mv (a failed get leaves the last good file).
# Token never in argv, never printed, never logged. A failed get is one log
# line; it does not fail the publish.
ssh -o BatchMode=yes e2e-lab 'mkdir -p /home/eta/oc/fleet-json/sarvam'
for caller in $(python3 -c 'import json;print(" ".join(json.load(open("/Users/vinaybhardwaj/dev/_fable/herdr/fleetboard/sarvam_callers.json"))["callers"]))'); do
  ssh -o BatchMode=yes e2e-lab '
    TOKEN=$(cat /home/eta/.claude/secrets/cloudflare_api_token 2>/dev/null)
    if [ -z "$TOKEN" ]; then echo no-token; exit 2; fi
    CLOUDFLARE_API_TOKEN="$TOKEN" npx wrangler r2 object get eta-lab-results/lanes/sarvam-'"$caller"'.json --remote --file /home/eta/oc/fleet-json/sarvam/'"$caller"'.json.tmp 2>&1 | tail -1
    if [ -s /home/eta/oc/fleet-json/sarvam/'"$caller"'.json.tmp ]; then
      mv /home/eta/oc/fleet-json/sarvam/'"$caller"'.json.tmp /home/eta/oc/fleet-json/sarvam/'"$caller"'.json
      echo got
    else
      echo "not found"
    fi
  ' >> "$LOG" 2>&1
done
echo "$STAMP OK machines=$(python3 -c 'import json;print(len(json.load(open("/tmp/_fleet.json"))["machines"]))') agents=$(python3 -c 'import json;print(len(json.load(open("/tmp/_fleet.json"))["agents"]))')" >> "$LOG"
