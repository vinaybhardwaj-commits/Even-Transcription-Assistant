#!/bin/sh
# 3 fresh processes x shifts {0,2} x threads {1,4}; one JSON line each into det.jsonl
cd ~/orbox-lab/o3; date +%T > det_start.txt; rm -f det.jsonl
for th in 1 4; do for s in 0 2; do for i in 1 2 3; do
  /var/lib/orb3-lab/venv/bin/python scorer3.py det $th $s | sed "s/^{/{\"rep\": $i, /" >> det.jsonl
done; done; done
date +%T > det_end.txt; echo DET_DONE >> det.log
