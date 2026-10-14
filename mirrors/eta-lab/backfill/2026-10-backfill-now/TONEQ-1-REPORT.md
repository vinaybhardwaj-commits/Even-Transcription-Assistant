DONE
1. heldout.py sha16 verified: f672c1ef046089dd (/home/eta/eta-data/drtpqma/heldout.py and all 3 split2-job copies identical). Union = R3/W51 excluded_room_days_union, union sha16 f07171dcb708d080 (asserted by heldout.load_union itself, 14 entries).
2. Scope found: /home/eta/eta-data/hist/tone = 2035 tone record files (all bw_*_primary.json under tone/runs/) + 6 provenance.json (non-records, left in place). Tone outputs in /home/eta/eta-data/reb/*/*/*/tracks/ matching engine "tone*": none exist (0 files).
3. Classification: per-record id looked up in the tone worklist (4394 rows); day = true IST of start_ms AND end_ms-1s; blind = either day in heldout union (refuter-3 #6927 end-exclusive rule). 0 records lacked the worklist lookup.
4. Counts: total 2035; blind 134 (nightly-20260927: 4 / nightly-20260928: 130); non-blind 1901. Room-days of the blind: 26 Sep OPD4 x4, 28 Sep OPD4 x48, 28 Sep OPD7 x82 — exactly matches herdr-lead's 134 (gap = 0) and eta-refuter-3 #8346 / sig-debug #8354.
5. Plan: /home/eta/oc/backfill-now/TONEQ-1-plan.json (sha16 5f7f1ef698f55af0) — every blind record path + room-day + counts.
6. Move: mv (never overwrite, no rm/delete) into /home/eta/eta-data/hist/_to_delete/tone-blind-20261007/ preserving the relative path tone/runs/<run>/<file>. 134/134 moved; dir check confirms 134 files present.
7. Manifest: /home/eta/oc/backfill-now/TONEQ-1-moved.json (sha16 43e47ca2428f0e70) — source path, destination, sha256 per file.
8. Verify: full re-sweep after the move (/home/eta/oc/backfill-now/TONEQ-1-verify.json, sha16 df3e2576ffd29718): records remaining 1901, blind remaining = 0, room-day list empty.
9. Untouched (per Do-NOT list): hist/state.jsonl, hist/claims, hist/runs, runner.py, box/c3 loops, HF items, tone/claims. Nothing was deleted; only the 134 mv's with -n semantics.
