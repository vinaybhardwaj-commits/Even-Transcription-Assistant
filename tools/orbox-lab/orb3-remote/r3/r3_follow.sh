#!/bin/sh
# R3 follow-ups after the matrix: (F1) repeat rate of the C2 th1 sh2 divergence, (F2) same input 3x inside ONE process,
# (F3) the builder's own 'shifts' mode of scorer3.py (one process, 8 shifts) run from MY copy in r3/.
cd ~/orbox-lab/r3 || exit 1
P=/var/lib/orb3-lab/venv/bin/python
r() { tag=$1; shift; $P r3run.py "$@" 2>>r3f.log | sed "s/^{/{\"check\": \"$tag\", /" >> r3f.jsonl; }
echo "START $(date +%T)" >> r3f.log
for i in 1 2 3 4 5 6; do r F1 dfn_snr0_B 1 2; done
r F2 dfn_snr0_B 4 2 inproc3
r F2 raw_snr5_A 4 3 inproc3
rm -f shifts3.jsonl; $P scorer3.py shifts 4 > F3_shifts.log 2>>r3f.log
echo "END $(date +%T)" >> r3f.log; echo R3F_DONE >> r3f.log
