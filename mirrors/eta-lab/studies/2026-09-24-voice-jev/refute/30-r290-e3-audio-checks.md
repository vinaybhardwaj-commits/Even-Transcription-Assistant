# 30. Ruling 290: checks for vj-data's E-3 audio build (4 windows without production rows), set before the build lands. vj-refuter, 25 Sep ~02:40
Ruling 289 (rule v2 + g034/g017 accepted; two-places flag = batch-3 candidate) needs nothing from me.

## What I will check
1. Audio provenance: the audio is cut from raw R2 chunks for exactly the 4 E-3 windows. I compare window times against the E-3 manifest in /srv/vj-truth, as vjscore, reading times only. I also re-cut a sample and compare sha256.
2. Blinding: the build reads ids and times only. It never reads /srv/vj-truth or label values, and auth.log shows no vjscore use by vj-data. Label values never enter the items.
3. Card parity: same card code and frozen wording as the other cards (C1/C2), Indic lines per r223, and the three hashes stamped.
4. Scoring, under the frozen COMBINE_RULE v7 (d36c9472569d), with no change to the pass bar:
   - Arm-1-less items have no arm-1 answer and no DOUBTFUL/CONFIDENT flag (D1 needs the arm-1 export).
   - So they cannot enter the S2 paired comparison, F2, F3 or F4.
   - I report them as a separate descriptive stratum: each arm's accuracy vs truth, n, and unsure count.
   - They are not pooled into F1's n.
   - Any other use needs a Fable ruling BEFORE the arms run on them.

## Pre-check, 02:15 IST (uncommitted data/ files: e3_audio.py, add_e3x.py, e3x_audio_report.json, classify186.py/handoff.py edited 02:10)
- Check 1, times: PASS. 4 windows (gf2zntnq 1789979400000; gkzmch9p 1789191000000 and 1789201800000; qjmagw6k 1789452000000).
  - The 44 pseudo-turns equal the truth store's (window, start, end) keys: 8/13/13/10, checked as vjscore with times only.
  - All lie inside the rebuilt 900 s wav (covered 1.0, gap 0).
  - The audio sha re-cut is pending the announced output path.
- Check 2, blinding: PASS so far.
  - e3_identities.json holds window/start/end only.
  - auth.log: no vjscore use between 22:01 and 02:10 IST apart from mine; the build ran on the box, which has no truth store.
- D1, MUST-FIX (sent as bus #1540-ish):
  - E3X pseudo-rows (role None) enter turns.json, and classify186 then sets arm1_doctor False.
  - handoff would put them into arm1_in.jsonl with only production_row False, and neither scorer filters that flag.
  - Result: 44 labelled turns would enter F1-F3 and the "empty" weight with a fabricated arm-1 answer.
  - Fix: keep them out of arm1_in and hand them off in a separate file.
  - arm1_in.jsonl is still the 21:49 version, so nothing has run yet.
- D2, caveat: E3X turn boundaries are the human clip cuts (one speaker each), and there is no production context, so the stratum is not comparable with production turns.
- vj-arms a7279f5 (02:14), reviewed: PASS.
  - arm1.py and score.py raise on any production_row=false row.
  - select_turns adds --extra-ids only for ids ABSENT from arm 1 (`set(extra_ids) - have`), so it cannot pull an arm-1 turn out of its normal selection.
  - The combine rule is unchanged (v7 d36c9472569d).
  - E3X arm outputs are keyed out of S2/F1-F4 in both scorers: they have no arm-1 row, and indep_score2 at 2945af5 also drops non-production rows.
  - D1 closes when vj-data's new hand-off shows arm1_in without E3X plus the separate E3X ids file.
