#!/bin/bash
# renice_deid.sh — ruling 225 (box overload): keep every de-id process (deid.py / deid_gpu.py, all threads) at nice 15 so the HIST audio cut/encode and the box's other work are not starved.
# Only lowers priority of same-user processes named deid*.py; never touches threads env or anything else. Stops when ~/eta-data/hist/RENICE_STOP exists. Logs counts only.
while [ ! -e "$HOME/eta-data/hist/RENICE_STOP" ]; do
  n=0
  for pid in $(pgrep -f 'python.*deid[a-z_]*\.py' 2>/dev/null); do
    [ -d /proc/$pid/task ] || continue
    if [ "$(ps -o ni= -p $pid 2>/dev/null | tr -d ' ')" != "15" ]; then renice -n 15 -p $(ls /proc/$pid/task) >/dev/null 2>&1 && n=$((n+1)); fi
  done
  [ $n -gt 0 ] && echo "$(date +%T) reniced $n de-id process(es) to 15"
  sleep 20
done
