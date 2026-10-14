#!/bin/bash
# What the fleet-watch herdr pane runs. If the watcher loop ALREADY holds the lock (another pane or a headless run), only tail its logs; otherwise start the wrapper loop here.
cd "$HOME/fleet-watch" || exit 1
if flock -n lock -c true 2>/dev/null; then
  exec bash "$HOME/fleet-watch/fleet-watch.sh"
fi
echo "fleet-watch: the loop is already running (it holds the lock); tailing its logs. MODE=$(cat MODE 2>/dev/null)"
touch wrapper.log notify.log; mkdir -p dry; touch dry/notify.log
exec tail -n 30 -F wrapper.log notify.log dry/notify.log
