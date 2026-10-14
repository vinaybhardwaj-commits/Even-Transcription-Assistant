#!/bin/bash
# herdr-lead 7 Oct 2026: wrapper for the 25 Sep-7 Oct room-audio backfill (order ORDERS-BACKFILL-NOW-07-OCT.md sha16 5a27ee4b).
# 13:55 venv-r2 interpreter (boto3). 14:00 --bg = loop of short chunks, each under its own flock /home/eta/gpu.lock,
# lock released between chunks so diar-lab's consult backfill takes turns on the T4 (consult-lead request).
set -euo pipefail
SELF=$(readlink -f "$0")
cd /home/eta/dev/eta-lab/studies/2026-09-24-hist-bulk
want=696d48dd5f9b39ca
have=$(sha256sum runner.py | cut -c1-16)
[ "$have" = "$want" ] || { echo "REFUSED: runner.py sha $have != pinned $want"; exit 3; }
# ORDERS-BF-6 B (8 Oct): box provenance comes from the box's OWN measured stack file. The harness (provenance.published_stack_versions) ignores --stack-file for the notes label and picks the first
# "published" stack_versions*.json in HIST_STACK_VERSIONS_DIR; pin the dir to a box-only symlink dir and declare the file's sha256 (pinned below; any change => REFUSED).
BXSF=/home/eta/eta-data/hist/stack_versions.box-bf6.json; BXSHA=a497019b1d5927c85230aad3d8bfe6aa9b4118038de31109ff230fcc5fa1ac9f
[ "$(sha256sum $BXSF | cut -d' ' -f1)" = "$BXSHA" ] || { echo "REFUSED: $BXSF sha != pinned $BXSHA"; exit 3; }
export HIST_STACK_VERSIONS_DIR=/home/eta/eta-data/hist/stack-box HIST_STACK_VERSIONS_SHA256=$BXSHA HIST_BOX_STACKV=$BXSF
PY=/home/eta/.venv-r2/bin/python
CHUNK=${CHUNK:-3}
if [ "${1:-}" = "--bg" ]; then
  shift
  log=/home/eta/oc/backfill-now/run-$(date +%Y%m%d-%H%M%S).log
  setsid nohup bash "$SELF" --loop "$@" > "$log" 2>&1 < /dev/null &
  echo "started loop pid $! log $log"; exit 0
fi
if [ "${1:-}" = "--loop" ]; then
  shift; badrun=0
  while true; do
    [ -e /home/eta/oc/backfill-now/STOP ] && { echo "STOP file present, exiting $(date)"; exit 0; }
    last_start=$(date +%Y%m%d%H%M); out=$(flock /home/eta/gpu.lock $PY runner.py --tier C --routers :box --limit "$CHUNK" "$@" 2>&1) || true
    echo "$out"; echo "--- chunk end $(date +%H:%M:%S)"
    echo "$out" | grep -q "queue: 0 windows" && { echo "QUEUE EMPTY, done $(date)"; exit 0; }
    if echo "$out" | grep -q "'failed': $CHUNK}"; then badrun=$((badrun+1)); else badrun=0; fi
    [ $badrun -ge 2 ] && { echo "STOPPED: two chunks in a row all failed $(date)"; exit 4; }
    sleep 15
    # runner run_id is minute-granular: never start two chunks in the same minute (FileExistsError on the start manifest)
    while [ "$(date +%Y%m%d%H%M)" = "${last_start:-}" ]; do sleep 5; done
  done
fi
exec flock /home/eta/gpu.lock $PY runner.py --tier C --routers :box "$@"
