# 337c(2) pre-registration, ADDENDUM 1 (indic-mt, 25 Sep 2026; before any sheet or label exists). Answers eta-refuter #2111.

1. RETRACTION. My first post quoted "structural score >= 0.6 after" rates. Under a forced language the output script is forced, and most of the flag's reasons are script/language checks, so those rates pass by
   construction; they are withdrawn and will not be quoted again, alone or as a before/after pair. Structural numbers are shown only as output length (chars per audio second and per voiced second) beside the empty rate.
2. HALLUCINATION CHECKS (counts only; `hall_checks.py`, run on 350 results so far): (a) the same output string recurring >= 3 times: 8 distinct strings, 33 of 350 segments, 6 of them in >= 3 windows (kn: 19 of 95
   outputs, ml 7 of 26, hi 4 of 111); (b) voiced seconds by webrtcvad mode 2 and chars per voiced second, and "text on near-silence" (< 1.0 voiced s, >= 10 chars): 26 of 350. These flags go into the KEY (not the sheet) so
   results are reported with and without the suspect rows. (c) auto-detect disagreeing with the forced language at high confidence is measured on the sheet rows only (L4, `lid_check.py`), also into the key.
3. EMPTY re-runs are excluded from the blind sheet (a blank side reveals itself) and reported per cell as a LOSS: speech dropped (hi 6 %, ml 35 % so far).
4. IDENTICAL PAIRS: an extra ~10 % of rows (10 with N = 96) have the OLD text on both sides. A rater choosing A_better or B_better on them shows position bias; the rate is reported first and if it is above 20 % the
   whole sheet's A/B counts are reported as position-biased.
5. Labels renamed to A_better | B_better | same | neither_readable | unsure (same meaning as before). Everything else in PREREG-337c-rerun.md stands.
6. WHERE THE PREFIX SHUFFLE IS: `l4_restart.sh` in this directory, the python block after `echo "manifests shuffled"` is written just above it: for each shard k, `random.Random(20260925+k).shuffle(L)` over the manifest LINES, and a
   manifest line is ONE SEGMENT (id = window hash + segment index). The shard split itself is by record: cut_segments.py `list --shard k/4` takes every 4th RECORD of the sorted record list, so a shard holds whole windows but
   the order inside it is a row-level (segment-level) shuffle. Any prefix is therefore a random sample of segments within each shard; the four shards run in parallel, so the pooled prefix is a random sample over all four.
   (Caveat: sharding by sorted record path means shard k holds every 4th window in path order; rooms interleave across shards, so no shard is a single room. The counts file of the sheet reports the number of distinct
   windows and rooms per cell.)
7. LEDGER LINE (proposal for the conductor): IndicConformer-600M RNNT (the production decoding) returns EMPTY text on 80-100 % of the flagged SraVaani hi/kn/bn/ml/gu/ta/te/mr segments (177 segments), identical to the
   Mini's production service on the same wavs (3 of 3 checked), so on these segments the production IndicConformer path adds nothing.
