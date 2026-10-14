#!/bin/sh
# R3 matrix, all sequential, one fresh process per line. Output: r3.jsonl (one JSON line per run), r3.log (stderr + markers).
cd ~/orbox-lab/r3 || exit 1
P=/var/lib/orb3-lab/venv/bin/python
r() { tag=$1; shift; $P r3run.py "$@" 2>>r3.log | sed "s/^{/{\"check\": \"$tag\", /" >> r3.jsonl; }
echo "START $(date +%T)" >> r3.log
for th in 1 4; do for s in 0 2; do for i in 1 2 3; do r C2 dfn_snr0_B $th $s; done; done; done
for c in run4_spR_nzL_0_A raw_snr20_B; do for th in 1 4; do for i in 1 2 3; do r C3 $c $th 0; done; done; done
for i in 1 2 3; do r C4 dfn_snr0_B 1 2 noseed; done
for s in 0 1 2 3 4 5 6 7; do r C5 raw_snr5_A 4 $s; done
echo "END $(date +%T)" >> r3.log; echo R3_DONE >> r3.log
