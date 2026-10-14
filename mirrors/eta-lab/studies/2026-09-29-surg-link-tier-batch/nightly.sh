#!/bin/bash
# surg-link W46 nightly (Fable 28 Sep; eta-refuter PASS #5497 + #5503). Runs only if every executed file matches PINNED-nightly.sha256.
cd /home/eta/oc/surg-link || exit 1
LOG=/home/eta/eta-data/surg-link/nightly_cap_batch.log
if ! sha256sum -c --quiet PINNED-nightly.sha256 >>"$LOG" 2>&1; then echo "$(date -Is) MISMATCH: code differs from the reviewed pin; not run" >>"$LOG"; exit 2; fi
echo "=== $(date -Is) start ===" >>"$LOG"
bash run_real.sh cap-batch >>"$LOG" 2>&1; rc=$?
python3 pitch/run_tier_batch.py >>"$LOG" 2>&1; rc2=$?
echo "=== $(date -Is) end rc=$rc tier_rc=$rc2 ===" >>"$LOG"; exit $((rc | rc2))
