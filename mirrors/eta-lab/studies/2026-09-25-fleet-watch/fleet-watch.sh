#!/bin/bash
# fleet-watch pane wrapper (ruling 399): loops the watcher forever, restarts it if it dies, one log line per cycle (no secrets, no text).
# MODE file: "dry" (default; nothing leaves the box) or "live" (Mini bug log + conductor messages). Flip to live ONLY after eta-refuter-2's PASS.
cd "$HOME/fleet-watch" || exit 1
set -o pipefail
while true; do
  MODE=$(cat MODE 2>/dev/null || echo dry); ARGS="--loop"; [ "$MODE" = "dry" ] && ARGS="--loop --dry"
  echo "$(date -u +%FT%TZ) fleet-watch starting, mode=$MODE" | tee -a wrapper.log
  python3 bin/fleet_watch.py $ARGS 2>&1 | tee -a wrapper.log
  echo "$(date -u +%FT%TZ) watcher exited ($?), restarting in 30 s" | tee -a wrapper.log; sleep 30
done
