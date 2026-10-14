# 31. H05 pre-registered test: RESULT = PASS (run once). vj-refuter, 25 Sep ~05:15 IST
Test as frozen in refute/28 (amendment) and BATCH2-RULE v2 ea40f81c §4, before any 16 Sep data existed.
- Data: dtree84/link-rd_ykw2rxjj.json (OPD 4, 16 Sep; written 04:41 IST; 1,644 embedded turns, 4 clusters), plus its emb and turns.
- Encounter window: 15:30:12-15:35:09 IST (hist-stage1b items.json called/completed).

## Numbers (all reported, whatever they were)
- 44 embedded turns overlap the window. Seconds by nearest day-centroid (cos >= 0.5):
  - c35: 72.7 s (24 turns)
  - c28: 6.0 s
  - c40: 2.6 s
  - none: 33.3 s
- Dominant cluster = c35.
- c35 against the references:
  - OPD 4 19 Sep c40: **0.918** (bar 0.60)
  - OPD 7 23 Sep c200: **0.684** (bar 0.60)
  - OPD 5 23 Sep c62: 0.559
- Rule: c40 >= 0.60 AND (c62 or c200) >= 0.60. Result: **PASS**.

## Descriptive (not part of the test)
- Negative control: c35 against every stored print is at most 0.26 (Banerjee 0.22, Ankit TONOR 0.15, Dibyendu 0.24, Poornima 0.26, Salanki 0.17). So c35 is none of the 5 stored-print doctors.
- The linker's timing pairs on c35: Salanki 0.55 (3/4), Manoj 0.53 (7/8), Chandra Shekar 0.52 (5/5). The Salanki pairing is timing noise, since Salanki's print is 0.17. c35 is the room's dominant voice that day (759 core turns).
- The reference family's own weakness, from refute/27, still applies:
  - c40's pairing with Manoj had present 2/9;
  - c62 and c200 overlap each other by 228 s on 23 Sep.
  So the PASS shows that the H05 voice is the c40/c200 voice. Whether that voice is Manoj rests on the booking (the patient booked for arthroscopy with Manoj) and on V's blind confirmation.

## Consequence (per the frozen rule)
- H05 becomes a known-voice card: V confirms it blind. It is NOT HIGH on its own authority. It is scored in the known-voice stratum.
- 16 Sep OPD 4 (rd_ykw2rxjj) is excluded from scored cards. The reference days used here (19 Sep OPD 4, 23 Sep OPD 5/7) are neither evidence nor minting audio for Manoj (R3).
- There is no retry and no re-run on a later embedding of the same data.

## Reconciliation with vj-link's run (#1670; h05_result.json, 04:58 IST; frozen sha printed): SAME VERDICT, SAME NUMBERS
- Both runs: dominant = c35; cos 0.918 (c40), 0.684 (c200), 0.559 (c62); PASS.
- Two method differences, neither affecting the verdict:
  1. Window. vj-link used hist-miner's encounter bounds, 15:27:12-15:38:09 (102 turns). The frozen text (rule v2 §4) names called/completed, 15:30:12-15:35:09, which I used (44 turns). c35 dominates in both windows: 181.1 s vs next 77.0 s, and 72.7 s vs next 6.0 s. This is a deviation from the frozen wording, recorded, with no effect.
  2. Seconds counting. vj-link counts by each turn's own dense-cluster label, including non-top clusters 37/34. I count by nearest top centroid at cos >= 0.5, where the 37 voice falls into "none". The reference cosines are centroid-level and identical in both runs.
- vj-link's second voice (c37, 77 s in the wider window) is presumably the patient or a companion. That is consistent with my 33.3 s unmatched.
