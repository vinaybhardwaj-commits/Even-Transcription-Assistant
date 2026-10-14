# Refute: vj-arms scorer + combine on the fixture (17:00 IST; harness not yet declared ready)

## REPRODUCED on the mock fixture
- Their score.py re-run from arms/out/fixture-mock raw outputs produces a results.json identical to theirs (refute/fixture-rescore/).
- refute/indep_score.py was written from the COMBINE_RULE.md text alone and imports no arms/ code. It matches every arm on doubtful and confident accuracy, the b/c counts and the sign-test p:
  - arm1 18/31
  - arm2 8/31 (+4/-14, p 0.0309)
  - arm3 7/31 (+1/-12, p 0.0034)
  - arm4 10/31 (+4/-12, p 0.0768)
- The combine code follows R3.1-R3.3 and R4.1-R4.2. The rule-sha gate works (COMBINE_RULE 2d492c426198, same as the 16:42 witness).

## Findings
- H4 (decides the outcome): production's room_turn_speaker.role is only 'clinician' (8,444 rows) or NULL (80,283 rows). arm1.py sets is_doctor = (label == "doctor").
  - vj-data's export must map clinician to "doctor". If it passes the raw role through, arm 1 says "never doctor".
  - A NULL role is scored as not-doctor. That makes arm 1's doubtful baseline "always not doctor", i.e. the non-doctor base rate.
  - Scoring NULL as unsure instead would put arm 1 near 0 on doubtful turns, and any arm would "win".
  - Fable must ratify one mapping before scoring.
- H5 (count IDs): key.json is keyed by clip id (cw...) and counts per 60-90 s EXCERPT. There are 30 excerpts over 17 fifteen-minute windows. The scorer takes arm 1's counts from per-window arm1 rows and keys arm 4's L2 by window_id.
  - The unit and ID namespace must be the excerpt (clip id) throughout.
  - Arm 1's Nemotron and pyannote counts for SC30 must be the excerpt counts, not window counts.
  - A human-count id that matches nothing is dropped silently; only n_any shows it.
- H6: a turn with no arm output (never run) is scored UNSURE, the same as a failed call, and is not counted separately. Ask for n_missing next to errors_n.
- CORRECTION to 02/C2: key.json holds MACHINE counts (teacher, nemotron, pyannote per excerpt), not human truth. The human count truth exists only in truth/human-counts.json (not yet exported). The key.json fence protects machine counts only.
- H1 (doubtful rule conflict) is still open.

## Update 17:05 IST: INTERFACE.md + HASHES.txt landed
- HASHES.txt (stamped 16:46) matches my 16:42 witness: freeze b961291ae64c, COMBINE_RULE 2d492c426198, ARM4_PROMPT 9d155a2ffe3c.
- tests.py: 15/15 pass locally.
- H5 is mostly resolved. The SC30 runners use rater-facing clip ids (cw*) with public/cw*.mp3, and key.json is keyed by the same cw ids. The one remaining condition: Fable's human-counts.json export must be keyed by cw id, or the count match is 0/n.
- INTERFACE item 6: "direct" confident regressions exist only if the arms run on confident turns. Otherwise the zero-worse gate is trivially met (my defect 4). Recommend running the arms on a confident sample.
- Harness verdict: READY for real data on the refuter's side, conditional on Fable ruling H1 (doubtful rule), H4 (clinician/NULL mapping) and the arm 2/4 ASSUMED rules.
