# vj-refuter INTERIM verdict: arms 2-4 on NON-PAGE truth (24 Sep ~22:00 IST). The final verdict comes after the "Who is speaking" labels.

Stamps: freeze b961291ae64c; addendum 165 9c335c59c5be; addendum 166 87b8cdac4330; COMBINE_RULE v7 d36c9472569d; weights role_shares_doubtful.json@7fe7105cb6e5 (clinician 0.1017 / empty 0.8983).
Inputs (witnessed = vj-arms #1153): arm1 c5c34ee02c58, arm2 656b4032613b, arm3 8c493e76d5cf, arm4 85f7a96d6582, cards 98cdabce24f0. Truth /srv/vj-truth/score/in/truth_turns.jsonl sha12 cb0ab3eccc01 (100 turns = v_existing 67 + e3_recovered 11 + vpilot_voice_verified 22). results.json sha12 d0e38f269110 (stays in /srv/vj-truth).

## Procedure (runbook refute/22)
1. Coverage gate: all 100 usable truth turns have arm 2/3/4 answers on the current 1,723-card inputs.
2. auth.log audit before AND after scoring: every vjscore/vj-truth command is mine (plus one root auth.log grep at 16:04 UTC by another pane, which reads the log, not truth).
3. Truth mapped to turn ids INSIDE /srv/vj-truth (largest-overlap production turn, >= 50% of the clip).
4. Stability: seeded 20% of the 88 doubtful truth turns (18 ids) re-queried LIVE at temperature 0 (run_requery.sh into ~/vj/refute/requery).
5. Scored as vjscore with vj-arms' score.py AND my independent indep_score2.py (written from the COMBINE_RULE v7 text only). REPRODUCED: every number matches (accuracies, weighted and unweighted gains, b/c, McNemar p, unsure, confident flips, re-query agreement).

## Result (WITH all sources; doubtful n = 88, confident n = 12)
| arm | doubtful acc | vs arm 1 0.659 | weighted gain | b / c | p | unsure | stability (18) | F4 | status |
|---|---|---|---|---|---|---|---|---|---|
| 2 Jev raw vectors | 0.000 | -65.9 pp | -48.1 pp | 0 / 58 | <0.001 | 88/88 | 1.00 | INSUFFICIENT (n 12) | NOT_ADOPTED |
| 3 Jev cards | 0.227 | -43.2 pp | -37.8 pp | 3 / 41 | <0.001 | 66/88 | 1.00 | INSUFFICIENT | NOT_ADOPTED |
| 4 Gemini audio | 0.420 | -23.9 pp | -2.6 pp | 12 / 33 | 0.0025 (arm 1 better) | 21/88 | 0.556 | INSUFFICIENT | NOT_ADOPTED |
WITHOUT vpilot_voice_verified (doubtful n = 66): arm 2 -65.2 pp; arm 3 -34.8 pp (w -5.8); arm 4 -21.2 pp unweighted but +28.4 pp weighted (the sign conflict fails F2 under ruling 215); stability 0.571. All NOT_ADOPTED.

## Verdict per arm (interim; truth = non-page only)
- Arm 2: FAIL. Jev answers "cannot tell" on every doubtful raw-vector state (88/88 UNSURE). It cannot improve with more truth.
- Arm 3: FAIL. 66/88 UNSURE (Q1 below 0.70 or cannot_tell); where it answers it is right 20/22 on doubtful turns, but abstention dominates. More truth will not change the sign.
- Arm 4: FAIL. It loses unweighted to arm 1 and fails stability (only 56% of its answers repeat at temperature 0, < 90%). Stability does not depend on truth, so F5 fails regardless.
  - Note the SIGNAL: on EMPTY-role doubtful turns (doctors production did not attribute) arm 4 is 0.46 vs arm 1 0.44 (with) and 0.50 vs 0.12 (without the voice-verified source). It hears doctors that production misses, but unreliably.
- F4 is INSUFFICIENT for every arm (confident labelled n = 12 < 30) until the page labels land.
- Reproduction: every number reproduced exactly by my independent scorer, so each verdict is FAIL (reproduced), not NOT-REPRODUCED.

## Caveats
- Interim: the truth is doctor-heavy (75 doctor / 25 not). The "Who is speaking" page adds 80 doubtful + 10 confident human labels.
- Arm 1 is strong on clinician-role doubtful turns (0.85), because production's "clinician" is usually right when it fires.
- The arm 2/3 results mostly measure Jev ABSTAINING at the 0.70 threshold, not answering wrongly. Arm 3 answers only 22 of 88 doubtful turns.
