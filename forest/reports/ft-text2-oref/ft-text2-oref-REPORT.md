# ft-text2-oref REPORT (Opus 5.5 refuter, 6aa91f741083, 20 Oct 2026 ~05:45 IST the lab box)
Verdict: **PASS-WITH-FIXES**. Tests 22/22 (work/harness.py 18 + work/synth.py 4), mutants 16/16 killed (work/mut.out). Jev reruns: 12 of 20 allowed.
I wrote OWN-NUMBERS.txt (work/own_win.py, work/own_nums.py) before reading analyze.py. It matches the lane on every count, kappa, precision and verdict.
How I tested: a sandbox fake HOME (work/fh) holding copies only. I re-ran bolna_join, make_sample A and C, analyze final, dropin and bolna_episode, and every output came out byte- or frame-identical to the lane's real files. All sha12 values match DONE. Nothing under ft-calltext or rl-feat changed after PLAN.md (04:33).

## Acceptance items
- A1 PASS. My own recount gives 37 calls / 29 episodes / 37 rows: 15 on day 0, 19 with day < 3, 26 with day < 7. The result is the same if the 100 no-offset timestamps are read as IST instead of UTC.
  - 2 rows on or after the surgery day are dropped; they belong to the one call that sits on 2 Rx. 37 duplicate rows are removed.
  - The lane uses the calendar IST day. That is correct: gating-lead's days_from_rx is 1 lower on 446 of 604 rows. rx_date equals the consult_ist date on 1233 of 1233 rows.
  - Synthetic boundary test S1 covers Rx-1 23:30, Rx 00:30 (with offset and naive), the eve of surgery, the surgery day, day 14 23:50 and day 15 00:10.
- A2 PASS. The ftc_tag.py sha 54d97b97d0f6 is unchanged. The schema and verify() are imported, and the JSON section of the prompt is identical. Each of the 3 replacements matched once.
  - All 17 Bolna quotes re-verify with locate(). There are 0 unverified.
  - Cosmetic: one "the summary shows" remains in the prompt, the same as in rlf_tag.py.
- A3 PASS. A fresh draw of sample A with seed 20 reproduces sample_A.json. Sample C with seed 21 is byte-identical, even with S3 now in the pool (S3 has 0 contradictions).
  - ref_label.ask() receives only the text and the definitions. That makes it blind to Haiku and Jev, but it shares Jev's question wording (disclosed).
- A4 PASS, with one gap (fix 2). TABLES.md, VERDICTS.json, call_tags_jev, the drop-ins, the feature parquet and the COVERAGE cells all reproduce exactly.
- A5 PASS. My independent rule application gives DROP obj_cost and obj_going_elsewhere, FLAG 9 and KEEP 5.
  - obj_second_opinion fails the precision rule with only 3 reference positives ("too few positives"). It is FLAG through hneg_arb 5/5 anyway, so the verdict does not change.
  - PLAN.md (04:33) is older than every Jev and reference artefact. Summed Jev latency is 990 s, about 3 min of wall time at 6 workers, so the timeline is plausible.
- A6 PASS, with a wording fix. Row order is equal. outcome_revealed is never removed: 82+20 Haiku "revealed" calls have Jev p < 0.2 and all are kept. It is only added (S1 6 rows, S2 7 rows / 6 calls).
  - No new positives appear, and quotes and other fields are untouched. The synthetic test S2 covers the thresholds 0.19 / 0.2 / 0.22 / 0.79 / 0.8.
  - BUT the schema is a superset: 2 keys are added (jev_changed, outcome_revealed_jev_added), and the quotes of removed tags are kept. COVERAGE says "same schema", which is not accurate.
- A7 PASS. No call at or after T is used: T17 injects a synthetic leak call and it is excluded at T3 and T7.
  - Episodes with no call are NaN: 0 non-NaN cells among the 1215 (T3) and 1211 (T7) no-call episodes.
  - The P cells match the ftc_model final2 logs: h14 976/92 and 926/42, h90 572/90 and 545/63, ale 1005/102 and 947/44.
  - The primary columns use hf_ and the raw columns use h_ (test S4).
- A8 PASS. Every episode_id in every output is in D (0 non-D). I checked 5990 quotes of 4 or more words and 677 Bolna 6-word shingles against DONE, COVERAGE, TABLES, VERDICTS, the logs and the briefs: 0 hits. There are no long digit runs.
- Default behaviour (flag off) PASS. Without LEAK_UNION the output equals the delivered file. LEAK_UNION=1 writes a separate *_leakunion file, and its cells are unchanged (no S3 call has Jev p >= 0.8).

## Mutants (16/16 killed)
- Window 0..15; `<=` on the surgery day; naive timestamps read as IST; no dedup; gating-lead's days_from_rx.
- Drop-in: price threshold 0.25; outcome_revealed removable.
- DROP share 0.21; hf_outcome_revealed taken from the generic filter; arbitration direction; ECE without clipping.
- Leak screen not applied; day <= T; at-risk using `<` T; seed 22; primary columns from raw tags.
- 5 mutants survived the real-data tests because they changed nothing on this data. Synthetic tests S1-S4 were added and kill them.

## Issues and fixes
1. **The obj_going_elsewhere DROP rests on 1 call.** It has 34 of 164 Haiku positives contradicted, and the 20% rule needs 33.
   - 11 of its positives have Jev p in [0.13, 0.2).
   - Rerunning Jev on 12 calls gave a mean |dp| of 0.006 and a max of 0.07, and 4 of 192 cells crossed 0.2.
   - A Jev rerun could therefore flip it to FLAG. obj_cost has a wide margin (100 vs 73 needed).
   - DONE lists close calls for timing and undecided but not this one. Add it as a caveat. This is the rule applied correctly, so it is not a rule breach.
2. DONE and COVERAGE claim "median English stop-word share 0.44" and "romanized-Hindi marker list matched 0". No delivered code computes either, so neither can be re-derived. Add the code or delete the claims.
3. out/code/ lacks ft2common.py, dropin.py, jev_run.py, make_sample.py, ref_label.py, mbq.py and mk_cohort_values.py, but DONE gives a rebuild order from code/. Separately, the committed code/analyze.py differs from out/code/analyze.py in 8 output strings ("reference" vs "model reference"). The logic is identical, but the commit does not byte-reproduce TABLES.md or VERDICTS.json. Sync both.
4. COVERAGE says the drop-ins have the "same schema as the originals". It should say "original schema plus 2 keys; quotes of removed tags are retained".
5. A latent problem in bolna_join.ist(): an offset written without a colon (+0530) would be misread as UTC. There are none in this data (504 rows are +00:00, 100 are naive).

No source was edited; work/code is a copy and every mutant was reverted (cmp verified). No H rows were read, and no patient text was printed. ubus inbox: 0 unread.
