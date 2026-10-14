# Refute: vj-data CHECKPOINT-186 (rulings 186/187/188): REPRODUCED, with 3 notes

## Reproduced
- Embedding equivalence: the box GPU vectors (production install, speechbrain 1.0.0) vs my CPU env (1.0.3) on 20 random turns (seed 24092026). Cosine min = median = 1.000. The move to the box changes nothing (refute/equiv.py).
- 186 margin/best: independent recompute (refute/r186.py) from the stored turn vectors, the stored centroids and the window cluster embeddings.
  - 1,100 of 1,101 turns with a verified doctor and a vector agree.
  - The 1 difference is a boundary case: best = 0.49999..., which vj-data rounds to 0.5000 before comparing and I did not. That is consistent with the ruling 169 round-before-compare rule.
  - 322 verified-doctor turns have no vector (321 are < 0.8 s). All of them are DOUBTFUL.
- Final CONFIDENT = 173 unique turns (SC30 30: 19 Banerjee + 11 Salanki; W58 143: Banerjee). Every one passes confident-186, is not diarization_only, and has no count disagreement.
- 187 voice presence matches my per-turn findings (refute/11): Banerjee PRESENT on 19 Sep and one more day, 21 Sep unverified (4 turns >= 0.70), 23 Sep absent; Salanki PRESENT only on rd_ed8endsg; Ankit never confirmed in OPD 7.

## Notes
- N1 (structural): under 186, CONFIDENT requires best >= 0.50 to the doctor's centroid, so every confident turn is voice-matched to the DOCTOR (139/173 production 'clinician'). No not-doctor turn can ever be confident.
  - F4 therefore only tests "does the arm wrongly flip a doctor turn". The 34 confident turns where production says not-doctor (empty role) are the interesting ones for arm 1.
- N2 (selection must wait): the W58 confident turns rely on "missing count = no disagreement", because fresh pyannote counts for those 2 W58 windows are still running.
  - The 10 W58 items in selection.json can turn DOUBTFUL when the counts land. Re-run the selection after them, or keep the confident sample inside SC30 (30 = exactly the F4 minimum). This joins vj-data's own open questions for Fable.
- N3 (inputs): the page is still a fixed 150; ruling 188 sizes it to the shortfall. Dedupe against V labels and E-3 has not been applied.
  - The E-3 identities (59 turns, no labels) have been in refute/e3_identities.json since 19:1x. The relay has apparently not reached vj-data yet; re-sent.

## E-3 coverage (vj-data add_e3.py / e3_coverage.json): REPRODUCED
- Blinding OK: add_e3.py reads only refute/e3_identities.json (no labels).
- My independent mapping (Neon room_turn_speaker, >= 50% overlap) matches exactly:
  - only the 2 maaacrdh windows (23 Sep) have production turn rows, and 13 of 59 E-3 turns map (9/9 + 4/6);
  - the 4 other windows (gkzmch9p x2, qjmagw6k, gf2zntnq; 9-20 Sep) have ZERO production rows, so arm 1 has no answer there and those 46 turns cannot enter VJ scoring.
- Consequence for ruling 188 sizing: E-3 contributes at most 13 labelled (all DOUBTFUL, since Dibyendu has only a Meet centroid), before the two_voices/other_doctor exclusions. The >= 60 labelled-doubtful target needs about 47+ from V's pilot clips or the page.
