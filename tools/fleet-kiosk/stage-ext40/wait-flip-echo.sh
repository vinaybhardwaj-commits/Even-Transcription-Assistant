#!/bin/bash
# fable 8 Oct: wait (max 60 min) for Cardiology occupancy=nobody, then one flip run that restarts Chrome on Profile 3.
cd ~/eta-deploy/stage-ext40
# MID, TARGET (user@host), SVC (keychain service), KEY, PROFILE come from the local config (not in the repo)
. "${FLEET_KIOSK_CONFIG:-$HOME/.config/eta-fleet-kiosk/wait-flip.env}"
export NODE_PATH=~/pulse-watch/node_modules FLIP_TARGET_VER=0.1.1.40
export DATABASE_URL=$(cat ~/.claude/secrets/eta_database_url)
for i in $(seq 1 60); do
  o=$(node occ-check.mjs "$MID" 2>/dev/null)
  echo "$(date '+%H:%M:%S') try $i occ=$o"
  if [ "$o" = "nobody" ]; then
    ./flip-0111.sh --skip-uninstall --profile "$PROFILE" "$MID" "$TARGET" "$SVC" "$KEY" > flip-echo-run.log 2>&1
    echo "flip rc=$?"; exit 0
  fi
  sleep 60
done
echo "gave up: never idle in 60 min"
