#!/bin/zsh
# herdr view for the MacBook Air (V's laptop; also Fable's bridge — keep it light). Runs ON the Air.
LOG=$HOME/eta-lab-night/logs
mkdir -p $LOG; touch $LOG/night.log
while true; do
  clear
  echo "=== air (Apple M2, 8 cores, 16 GB) — lab CPU worker, AC power only — $(date '+%H:%M:%S') ==="
  pmset -g batt | sed -n 1,2p | tr '\n' ' '; echo
  memory_pressure | tail -1
  top -l 1 -n 10 -o cpu -stats pid,command,cpu,mem,time | tail -12
  echo "--- lab log ---"
  tail -n 16 $LOG/*.log 2>/dev/null | grep -v '^==>' | grep -v '^$' | tail -16
  sleep 10
done
