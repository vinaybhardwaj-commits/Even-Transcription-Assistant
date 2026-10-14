#!/bin/bash
# backfill-now 7 Oct 2026 (ORDERS-C4-LANE-1, backfill-lead): copy of run_c3.sh for eta-ci-c4 (clone of the repaired c3 stack, C4-PASS #9311), two router stacks :c4s0 (:8083) / :c4s1 (:8088).
# Runs from the box via ssh alias e2e-c4; claims stop duplicates with other lanes. Respects the c4 CI lock. NO end time (24 h). Own STOP file: /home/eta/oc/backfill-now/STOP-c4.
set -euo pipefail
SELF=$(readlink -f "$0")
cd /home/eta/dev/eta-lab/studies/2026-09-24-hist-bulk
want=696d48dd5f9b39ca; have=$(sha256sum runner.py | cut -c1-16)
[ "$have" = "$want" ] || { echo "REFUSED: runner.py sha $have != pinned $want"; exit 3; }
PY=/home/eta/.venv-r2/bin/python; CHUNK=${CHUNK:-3}
# ORDERS-C4-STACK-2 (8 Oct): c4 provenance comes from c4's OWN measured stack file. The harness (provenance.published_stack_versions) ignores --stack-file for the notes label and picks the first
# "published" stack_versions*.json in HIST_STACK_VERSIONS_DIR, which was stack_versions.c3.json; pin the dir to a c4-only symlink dir and declare the c4 file's sha256 (pinned below; any change => REFUSED).
C4SF=/home/eta/eta-data/hist/stack_versions.c4.json; C4SHA=861bb6615f49a14b1d3feaca64ee96be732c198913e1966c5ee2a165b911343d
[ "$(sha256sum $C4SF | cut -d' ' -f1)" = "$C4SHA" ] || { echo "REFUSED: $C4SF sha != pinned $C4SHA"; exit 3; }
export HIST_STACK_VERSIONS_DIR=/home/eta/eta-data/hist/stack-c4 HIST_STACK_VERSIONS_SHA256=$C4SHA
if [ "${1:-}" = "--bg" ]; then
  shift; log=/home/eta/oc/backfill-now/c4-$(date +%Y%m%d-%H%M%S).log
  setsid nohup bash "$SELF" --loop "$@" > "$log" 2>&1 < /dev/null &
  echo "started c4 loop pid $! log $log"; exit 0
fi
[ "${1:-}" = "--loop" ] && shift
badrun=0
while true; do
  [ -e /home/eta/oc/backfill-now/STOP-c4 ] && { echo "STOP-c4 file, exiting $(date)"; exit 0; }
  last_start=$(date +%Y%m%d%H%M); out=$($PY runner.py --tier C --routers ${ROUTERS:-:c4s0,:c4s1} --stack-file $C4SF --ci-lock /tmp/eta-ci-c4-ci.lock --limit "$CHUNK" "$@" 2>&1) || true
  echo "$out"; echo "--- chunk end $(date +%H:%M:%S)"
  echo "$out" | grep -q "queue: 0 windows" && { echo "QUEUE EMPTY $(date)"; exit 0; }
  if echo "$out" | grep -q "'failed': $CHUNK}"; then badrun=$((badrun+1)); else badrun=0; fi
  [ $badrun -ge 2 ] && { echo "STOPPED: two all-failed chunks $(date)"; exit 4; }
  sleep 15
  while [ "$(date +%Y%m%d%H%M)" = "${last_start:-}" ]; do sleep 5; done
done
# stack file = stack_versions.c4.json, measured ON c4 (c4_collect.py + c4_build_stack.py, ORDERS-C4-STACK-2); the router-fix DRAFT (copied from c3) is no longer used.
