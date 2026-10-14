#!/bin/bash
# Deletes an eta-data study folder 14 days after it writes its own .closed file.
# Never touches a folder without .closed. Logs name+size only (never contents).
set -euo pipefail
DATA_DIR="/Volumes/Air Drive/eta-data"
LOG="$HOME/dev/eta-lab/kit/cleanup.log"
NOW=$(date +%s)

[ -d "$DATA_DIR" ] || exit 0

for d in "$DATA_DIR"/*/; do
  d="${d%/}"
  closed="$d/.closed"
  [ -f "$closed" ] || continue
  closed_date=$(tr -d '[:space:]' < "$closed")
  closed_epoch=$(date -j -f "%Y-%m-%d" "$closed_date" +%s 2>/dev/null) || continue
  age_days=$(( (NOW - closed_epoch) / 86400 ))
  if [ "$age_days" -ge 14 ]; then
    size=$(du -sh "$d" 2>/dev/null | cut -f1)
    name=$(basename "$d")
    rm -rf "$d"
    echo "$(date '+%Y-%m-%d %H:%M:%S') deleted $name (was $size, closed $closed_date, age ${age_days}d)" >> "$LOG"
  fi
done
