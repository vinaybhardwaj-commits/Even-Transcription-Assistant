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

## New hand-off (box ~/eta-data/vj/handoff, 02:42; the voice-lab-1 copy is identical): PASS. D1 CLOSED (ruling 296)
- arm1_in.jsonl, sha12 7f0af18f28b0:
  - 13,022 rows: 0 E3X, 0 production_row False, 0 of the 44 E3X ids.
  - Compared with the 21:49 file vj-arms ran on (2bb21df39d87): same 13,022 turn ids, 0 field differences on all 13 fields, 0 doubtful/label changes. The 02:38 reclassification changed nothing for existing turns.
- e3x_in.jsonl + e3x_ids.txt: 44 = 44, the same id set.
  - Fields: turn_id, window_id, s, e, set, production_row, nemotron_n, pyannote_n. No role, no label.
- cards.jsonl / clips.jsonl: 1,767 = 1,723 unchanged (0 changed cards, 0 changed clips) + the 44 E3X exactly.
  - E3X cards have no doctor_name, and raw_text is present (C1).
- Audio: 6 random E3X clips re-cut by me from ~/eta-data/vj/audio/<window>.wav with handoff.py's ffmpeg settings: 6/6 byte-identical.
  - Limit: I did not re-download the R2 chunks. The chunk assembly rests on e3x_audio_report (4 chunks per window, gap 0, 900 s) plus my time check against the truth store.
- auth.log: no vjscore use by anyone but me since 22:01 IST.
- Report caveat D3 (added to D2): E3X cards show "Voice match: not available" and "Transcript: not available", because no production STT or diarization exists.
  - Arms 2 and 3 therefore judge from descriptors and diarizer counts only, while arm 4 hears audio. The stratum measures near-blind text arms, not the production condition.
- vj-arms may run E3X via --extra-ids e3x_ids.txt and re-copy the inputs. I score E3X as its own descriptive stratum.

## E3X run (vj-arms #1598) verified, and the E3X stratum scored (descriptive; outside S2/F1-F5). Stamps b961291ae64c 9c335c59c5be 87b8cdac4330, rule v7 d36c9472569d
- Append-only, checked by me on voice-lab-1: the first 1,723 lines of arm2/arm3 and the first 1,790 of arm4 hash to 656b4032613b / 8c493e76d5cf / 85f7a96d6582.
  - arm1 is unchanged (c5c34ee02c58).
  - New full files: arm2 554d07a0045f, arm3 eef524e54664, arm4 6989b4e7e9c8.
- Truth: e3_truth_r197 (ruling 197), matched on window + start/end at 0.1 s. 38 of 44 E3X turns carry usable truth: 27 doctor, 11 not-doctor. The other 6 have no usable r197 answer.
- Scored as vjscore, counts only, with R2/R3 mapping (threshold 0.70; unsure = wrong per R4):
  - arm 2: 0/38 correct (95% CI 0.00-0.09); all 38 unsure (cannot_tell).
  - arm 3: 0/38 (0.00-0.09); all 38 unsure.
  - arm 4: 33/38 = 0.87 (95% CI 0.72-0.95); 1 unsure. Doctor 23/27, not-doctor 10/11; 33/37 among answered.
  - The always-"doctor" baseline on this split is 27/38 = 0.71. P(>= 33 | p = 0.71) = 0.019, one-sided and exploratory.
- How to read it:
  - No arm-1 comparison exists (arm-1-less), so this says nothing about F2/F3.
  - The turns are human-cut, single-speaker clips with no production context (D2/D3). That is easier than production turns for arm 4, and it leaves the text arms blind.
  - Arm 4's 0.87 therefore shows the audio arm CAN separate doctor from not-doctor on clean single-speaker Cardiology clips. It does not show that arm 4 would pass on production turns: on production doubtful turns it scored 37/88 in the interim (refute/24).
