#!/bin/sh
# T1: per variant x cell: 3 fresh at th1, 3 fresh at th4, 3 calls in one process at th4. Lines tagged with cell and kind -> t1.jsonl
cd ~/orbox-lab/o4; date +%T > t1_start.txt; rm -f t1.jsonl
PY=/var/lib/orb3-lab/venv/bin/python
for v in V0 V1 V2; do
  for cell in a b; do
    if [ $cell = a ]; then ARGS="dfn run3 snr0 B 2"; else ARGS="raw run3 snr5 A 3"; fi
    for th in 1 4; do for i in 1 2 3; do
      $PY scorer4.py one $v $ARGS $th | sed "s/^{/{\"cell\": \"$cell\", \"kind\": \"fresh\", /" >> t1.jsonl
    done; done
    $PY scorer4.py one $v $ARGS 4 3 | sed "s/^{/{\"cell\": \"$cell\", \"kind\": \"inproc\", /" >> t1.jsonl
  done
done
date +%T > t1_end.txt; echo T1_DONE >> t1.log
