# Refute: vj-data ruling 182 step 1 + 3 (roomday_doctor.json, rescore_182.json)

## R1 (decides the outcome): USABLE ignores the SC30 excerpts
- rescore_182.py line 44-46 computes USABLE from median_best_15min_windows only. The excerpts are counted but not used.
- Salanki: 0 fifteen-minute windows, 4 excerpts with best = 0.889, 0.845, 0.803, 0.653 (median about 0.82, and the top cluster is production's clinician cluster). He is marked USABLE = false.
- Under 165 C, the "window" for SC30 IS the cw excerpt. With excerpts counted, Salanki passes (n = 4, small; report n).
- Banerjee: excerpts include 0.842 and 0.814 (top cluster is the production clinician), but the 15-min median is 0.179. See R3.

## R2: the PQM cross-check misclassifies in BOTH directions (checked against my per-turn voice test, refute/11)
- rd_93tcdc4c (OPD 3, 21 Sep, bw_j45jmzam) is EXCLUDED because PQM shows no Banerjee consult overlapping the window. Yet my per-turn test finds Banerjee clearly present: max 0.757, 9 turns >= 0.5, and production's 6 clinician turns average 0.535.
- rd_pw5gaugg (OPD 3, 23 Sep, bw_nrqthr5b) is "consistent" because PQM shows 1 Banerjee consult. My per-turn test finds him absent from those windows (max 0.20-0.46, 0 turns >= 0.5).
- Cause: PQM has no room dimension and ~20 doctors consult at once. Window-level overlap of consult calls is a weak, noisy signal. A single overlapping consult passes a room-day, and a doctor whose consults are logged outside the recording window fails.
- It follows Fable's addendum literally, but it is not evidence of presence. Suggest: for the centroid decision, use voice presence (per-turn matches) on the room-day as the test, with production and PQM reported next to it. Or require >= 3 PQM consults inside the window for "consistent". Fable to rule.

## R3: cluster-level metric (repeat of refute/11 conclusion 2)
- The 15-min Banerjee median 0.179 uses cluster embeddings, and it includes 23 Sep windows where he is absent. On his present days the per-turn p90 is 0.69-0.81. The per-turn metric is needed.

## R4: a centroid is scored outside its room/mic
- Ankit's OPD 7 TONOR centroid is scored on room_yh3etjpf (OPD 1) excerpts (best 0.11-0.15). Banerjee has a row in ORB3 (room_jwyrr4dc).
- Under 166 A a stored centroid applies only to its own room-mic source. For another room it should be "no room-mic centroid" (margin missing), not a failed match. The outcome here is the same (unusable), but the verdict reason is wrong, and it would pull down the median if it were mixed with the doctor's own-room windows.

## What stands if R1-R4 are fixed (my estimate, to be reproduced when vj-data re-runs)
- Salanki: USABLE on OPD 5 excerpts (n = 4).
- Banerjee: USABLE on OPD 3 on his present days (19 and 21 Sep windows and the sc30-06/-15 excerpts); unusable/absent on 23 Sep.
- Ankit: no matched own-room test data, so margin MISSING.
