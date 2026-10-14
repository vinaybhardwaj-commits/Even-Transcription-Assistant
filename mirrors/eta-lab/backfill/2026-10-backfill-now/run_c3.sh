#!/bin/bash
# herdr-lead 7 Oct 2026 14:10: second lane for the 25 Sep-7 Oct backfill on eta-ci-c3's two router stacks (proven 26 Sep-5 Oct, 6,372 window states).
# Runs from the box; claims stop duplicates with the :box loop. Respects the c3 CI lock. Exits by 20:15 IST (stt-bench owns c3 from 20:45).
set -euo pipefail
SELF=$(readlink -f "$0")
cd /home/eta/dev/eta-lab/studies/2026-09-24-hist-bulk
want=696d48dd5f9b39ca; have=$(sha256sum runner.py | cut -c1-16)
[ "$have" = "$want" ] || { echo "REFUSED: runner.py sha $have != pinned $want"; exit 3; }
# ORDERS-BF-6 B (8 Oct): c3 provenance comes from c3's OWN measured stack file (the harness label ignores --stack-file; see ORDERS-C4-STACK-2). Dir pinned to a c3-only symlink dir, file sha256 declared published and checked here.
C3SF=/home/eta/eta-data/hist/stack_versions.c3-bf6.json; C3SHA=965fb3e93bdc79f890cee802fa1bfb132bc2235cfbee3b3c5a0280950d9024a8
[ "$(sha256sum $C3SF | cut -d' ' -f1)" = "$C3SHA" ] || { echo "REFUSED: $C3SF sha != pinned $C3SHA"; exit 3; }
export HIST_STACK_VERSIONS_DIR=/home/eta/eta-data/hist/stack-c3 HIST_STACK_VERSIONS_SHA256=$C3SHA
PY=/home/eta/.venv-r2/bin/python; CHUNK=${CHUNK:-3}; END=${END:-2015}
if [ "${1:-}" = "--bg" ]; then
  shift; log=/home/eta/oc/backfill-now/c3-$(date +%Y%m%d-%H%M%S).log
  setsid nohup bash "$SELF" --loop "$@" > "$log" 2>&1 < /dev/null &
  echo "started c3 loop pid $! log $log"; exit 0
fi
[ "${1:-}" = "--loop" ] && shift
badrun=0
while true; do
  [ -e /home/eta/oc/backfill-now/STOP ] && { echo "STOP file, exiting $(date)"; exit 0; }
  [ "$(TZ=Asia/Kolkata date +%H%M)" -ge "$END" ] && { echo "END time $END reached, exiting $(date)"; exit 0; }
  last_start=$(date +%Y%m%d%H%M); out=$($PY runner.py --tier C --routers ${ROUTERS:-:c3s0} --stack-file $C3SF --ci-lock /tmp/eta-ci-c3-ci.lock --limit "$CHUNK" "$@" 2>&1) || true
  echo "$out"; echo "--- chunk end $(date +%H:%M:%S)"
  echo "$out" | grep -q "queue: 0 windows" && { echo "QUEUE EMPTY $(date)"; exit 0; }
  if echo "$out" | grep -q "'failed': $CHUNK}"; then badrun=$((badrun+1)); else badrun=0; fi
  [ $badrun -ge 2 ] && { echo "STOPPED: two all-failed chunks $(date)"; exit 4; }
  sleep 15
  while [ "$(date +%Y%m%d%H%M)" = "${last_start:-}" ]; do sleep 5; done
done
# 14:15 herdr-lead: :c3s1 returned ok-but-0-segments on 6/6 windows; lane restricted to :c3s0 until eta-refuter-2 clears s1.
# 15:50 backfill-lead: c3 re-enabled on BOTH stacks after router-fix C3-REPAIR-1 + eta-refuter-2 C3-PASS #9195 (one shared CPU whisper: ~2x wall accepted).
