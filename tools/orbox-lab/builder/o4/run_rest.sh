#!/bin/sh
# T2 (fresh process per shift + one in-process 8-shift run), T3 (run4 micA/micB 8 files, shift 0, fresh each), T4 (scorer3 x10 fresh, th1). Variant given as $1.
V=$1; PY=/var/lib/orb3-lab/venv/bin/python; cd ~/orbox-lab/o4; rm -f t2_fresh.jsonl t2_inproc.jsonl t3.jsonl t4.jsonl
date +%T > rest_start.txt
for s in 0 1 2 3 4 5 6 7; do $PY scorer4.py one $V raw run3 snr5 A $s 4 >> t2_fresh.jsonl; done
$PY scorer4.py shifts $V 4 > t2_inproc.jsonl
date +%T > t2_end.txt
for t in spL_nzR_0 spR_nzL_0 both_0 spL_nzR_m5 spR_nzL_m5 both_10_g31 both_10_g41 both_10_g51; do for m in A B; do
  $PY scorer4.py one $V raw run4 $t $m 0 4 >> t3.jsonl; done; done
date +%T > t3_end.txt
cd ~/orbox-lab/o3; for i in 1 2 3 4 5 6 7 8 9 10; do $PY scorer3.py det 1 2 >> ~/orbox-lab/o4/t4.jsonl; done
date +%T > ~/orbox-lab/o4/t4_end.txt; echo REST_DONE >> ~/orbox-lab/o4/rest.log
