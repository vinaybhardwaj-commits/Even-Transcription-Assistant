#!/bin/zsh
# herdr view for ehrc-audiometry (3rd-floor consult room recorder, night lab worker). Runs ON the machine.
# No tmux/htop there: redraw every 10 s — top CPU/memory, memory pressure, lab log tail.
LOG=$HOME/eta-lab-night/logs
mkdir -p $LOG; touch $LOG/night.log
while true; do
  clear
  echo "=== ehrc-audiometry (Apple M4, 16 GB) — night lab worker — $(date '+%H:%M:%S')   window 20:30–07:30 ==="
  memory_pressure | tail -1
  top -l 1 -n 12 -o cpu -stats pid,command,cpu,mem,time | tail -14
  echo "--- lab log ---"
  tail -n 18 $LOG/*.log 2>/dev/null | grep -v '^==>' | grep -v '^$' | tail -18
  sleep 10
done
