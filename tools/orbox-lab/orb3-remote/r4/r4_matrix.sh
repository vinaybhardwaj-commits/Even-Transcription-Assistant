#!/bin/sh
# R4 matrix, sequential. One JSON line per score -> r4.jsonl (tagged with check). stderr -> r4.log.
cd ~/orbox-lab/r4 || exit 1
P=/var/lib/orb3-lab/venv/bin/python
r() { tag=$1; shift; $P r4run.py "$@" 2>>r4.log | sed "s/^{/{\"check\": \"$tag\", /" >> r4.jsonl; }
A=dfn:run3:snr0:B:2; B=raw:run3:snr5:A:3; C=dfn:run3:snr0:B:0      # C = new cell: fell back 5/12 segments in R3 C2
echo "START $(date +%T)" >> r4.log
for V in V1 V2; do
  for c in $A $B $C; do for th in 1 4; do for i in 1 2 3; do r D2 one $V $th $c; done; done; done
  r D2 inter $V 4 5 $A $B $C
done
echo "D2_END $(date +%T)" >> r4.log
r D3 seq V1 4 raw:run3:snr5:A:7 raw:run3:snr5:A:6 raw:run3:snr5:A:5 raw:run3:snr5:A:4 raw:run3:snr5:A:3 raw:run3:snr5:A:2 raw:run3:snr5:A:1 raw:run3:snr5:A:0
echo "D3_END $(date +%T)" >> r4.log
for t in spL_nzR_m5 spR_nzL_m5; do r D4 one V1 4 raw:run4:$t:B:0; done
for t in spR_nzL_0 both_0 both_10_g41; do r D5 one V1 4 raw:run4:$t:B:0; done
for V in V1 V2; do for t in spL_nzR_0 spR_nzL_0 both_0 spL_nzR_m5 spR_nzL_m5 both_10_g31 both_10_g41 both_10_g51; do r D6 one $V 4 raw:run4:$t:A:0; done; done
echo "END $(date +%T)" >> r4.log; echo R4_DONE >> r4.log
