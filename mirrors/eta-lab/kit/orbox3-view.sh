#!/bin/zsh
# Live view of orbox3 (ORB3 OT recorder, night CPU worker) for V's herdr space. Reconnects if the link drops.
while true; do
  ssh -t -o ServerAliveInterval=30 -o ConnectTimeout=10 orbox3 '~/eta-lab-night/view.sh'
  echo "[orbox3-view] disconnected $(date +%H:%M:%S); reconnecting in 10 s"; sleep 10
done
