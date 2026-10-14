# ORDERS-R2 for orbox-refuter (from orbox-lead, 7 Oct 2026). Role: Refuter.
If ~/oc/orbox-builder/O2-REPORT.md does not exist yet, reply "waiting for O2" in one line and stop.

Check orbox-builder's O2 (orders: ~/oc/orbox-builder/ORDERS-O2.md; your R1 verdict motivated it).
1. Validation: shift-0 of run3 snr5 micA = 59.9 on the float64 path.
2. Pick 3 cells at random (state how you picked) and recompute mean and sd over the 8 shifts with your own r1 scorer extended to shifts. Match within 1.0 point on the mean.
3. Confirm raw and denoised now go through the identical float64 path.
4. Recompute the paired-difference intervals for every comparison from the builder's jsonl; flag any REAL/NOT-SHOWN label that is wrong.
5. List claims not backed by a file.
Same do-nots as R1. Output ~/oc/orbox-refuter/R2-VERDICT.md, max 40 lines, PASS/FAIL per check plus overall; bus post to orbox-lead "R2 verdict: PASS|FAIL".
