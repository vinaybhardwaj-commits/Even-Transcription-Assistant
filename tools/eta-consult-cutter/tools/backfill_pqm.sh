#!/usr/bin/env bash
# m3-17: September PQM backfill, started BY HAND by consult-lead (no unit, no timer). Runs the driver from the deployed worktree at nice 19 under its own flock; one copy at a time.
# The driver cuts one window per cutter.run call (cutter.lock + gpu.lock like the hourly run), skips what is already cut (resumable), and exits when done, on ~/eta-data/consult/pqm.stop, or at --max.
# Log: ~/oc/consult/cutter-logs/backfill-pqm-YYYYMMDD.log.   Usage: tools/backfill_pqm.sh [--max N] [--dry-run]
set -uo pipefail
D="${BACKFILL_PQM_CUTTER:-$HOME/oc/consult/cutter-deploy}"; PY="${BACKFILL_PQM_PY:-$HOME/oc/consult/cutter-venv/bin/python}"; LOCK="${BACKFILL_PQM_LOCK:-$HOME/eta-data/consult/backfill-pqm.lock}"
exec 9>"$LOCK"; flock -n 9 || { echo "another backfill_pqm is running"; exit 0; }
cd "$D" && exec nice -n 19 "$PY" "$D/tools/backfill_pqm.py" "$@"
