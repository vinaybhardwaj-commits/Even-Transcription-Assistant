#!/bin/bash
# vj-refuter P1/P4 (+P2, P3): full-pipeline placebo suite on the 41 dense 18-24 Sep room-days, beside the real run.
#  14 placebos: doctor times (PQM and Rx) shifted by a wrong number of HOURS (+-4, +-5, +-6, +-7) and DATE offsets 1..6 (another date's consults and Rx moved onto this day, same kind of date only).
#  Each placebo re-runs voicelink (voice timing, best doctor, Rx by voice) and edge alignment, then the grouping/tiering (complete linkage = P2 default, and single linkage for comparison).
set -u
cd "$(dirname "$0")"
B=~/eta-data/voice-linkage; P=$B/pilot; T=$B/dtree18; V=$B/venv-gpu/bin/python; OV=$B/overnight
export OMP_NUM_THREADS=2 MKL_NUM_THREADS=2
mkdir -p $T; RDS=$(python3 -c "import json;print(' '.join(json.load(open('$OV/rds.json'))))")
for rd in $RDS; do for f in $P/turns-$rd.json $B/dense/emb-$rd.npz $B/dense/emb-$rd.json; do ln -sf $f $T/; done; done
for f in $P/pqm-2026-09-1[89].csv $P/pqm-2026-09-2?.csv $P/rx-2026-09-1[89].json $P/rx-2026-09-2?.json $P/edge-2026-09-1[89].json $P/edge-2026-09-2?.json; do ln -sf $f $T/; done
ln -sfn $P/audio $T/audio
# the DOFF pool must be the 18-24 dates only (same kind): the extension's 9-15 Sep pqm files are not linked into $T
export LINK_H=$T
run_vl() { rd=$1; shift; env "$@" $V voicelink.py $rd > /dev/null 2>&1; }
export -f run_vl; export V LINK_H
echo "== real voicelink"; for rd in $RDS; do $V voicelink.py $rd > /dev/null 2>&1; done
DATES=2026-09-18,2026-09-19,2026-09-20,2026-09-21,2026-09-22,2026-09-23,2026-09-24
echo "== edge placebos (real edge files are linked)"
( for h in 6 -6 7 -7; do PLACEBO_H=$h python3 edge.py $P /tmp/lxreuse $DATES > /dev/null 2>&1 & done; wait
  for k in 1 2 3 4 5 6; do PLACEBO_DOFF=$k python3 edge.py $T /tmp/lxreuse $DATES > /dev/null 2>&1 & done; wait ) 
# edge.py with PD=$T needs turns files: linked above; the +-4/+-5 hour edge files exist in $P
for f in $P/edge-2026-09-??-pl*.json; do ln -sf $f $T/; done   # (the -pd files were written into $T directly: never link a file onto itself)
echo "== voicelink placebos"
JOBS=""; for rd in $RDS; do for h in 4 -4 5 -5 6 -6 7 -7; do JOBS="$JOBS $rd:PLACEBO_H=$h"; done; for k in 1 2 3 4 5 6; do JOBS="$JOBS $rd:PLACEBO_DOFF=$k"; done; done
echo $JOBS | tr ' ' '\n' | xargs -P 6 -I{} bash -c 'j={}; run_vl "${j%%:*}" "${j#*:}"'
echo "== groups"; mkdir -p $T/overnight
for mode in complete single; do
  for suf in "" -pl4 -pl-4 -pl5 -pl-5 -pl6 -pl-6 -pl7 -pl-7 -pd1 -pd2 -pd3 -pd4 -pd5 -pd6; do
    GROUP_MODE=$mode $V overnight_groups.py $suf > $T/overnight/groups-$mode$suf.log 2>&1
    cp $T/overnight/glinks$suf.json $T/overnight/glinks-$mode$suf.json
  done
done
echo PLACEBO_SUITE_DONE
