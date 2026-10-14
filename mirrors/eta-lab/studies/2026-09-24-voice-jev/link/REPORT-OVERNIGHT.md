# Phase L, 18-24 Sep run (rulings 201-204, 219): page batch 1 (vj-link, 24 Sep night)

No names, no transcript text, no patient data here. Page (cards + audio, contract fields only): box `~/eta-data/voice-linkage/batch1/{links,audio}` (61 cards, 242 mp3, 5.6 MB; `check_cards.py --expect 61` OK).
Tier key (NOT for the page): box `~/eta-data/voice-linkage/batch1-key/`; PHI-free copies in `overnight/` here (ids and numbers).

## What the rules produced (ruling 201/202, Reading A, dense embeddings)
- 41 room-days (18-24 Sep, >= 300 transcribed turns, >= 8 window clips), 158 voices (top clusters), **77 voice groups** (same voice on different days, cos >= 0.85).
- **HIGH 1, MED 2, LOW 74.** Page (ruling 204: everything the rules give, filled to 60 link cards with LOW controls): **1 HIGH + 2 MED + 57 LOW** link cards + 1 "Same person?" pair. Fewer than 30 HIGH exist: the page must say the counts.
- Cross-day groups: 20; **17 of the 20 are STAFF CANDIDATES** (the same voice is the best match for different doctors on different days; never HIGH). One voice recurs on **31 room-days and names 16 different doctors** (a hospital-wide voice: attendant, announcement or a clinician who moves between rooms).
- The HIGH link: a Cardiology voice on 21 and 22 Sep, heard in 80% of the busy minutes of the doctor's consults vs 8% otherwise, 5 of 5 consults, 261 core turns, 3 prescriptions with drug/test words said by this voice, edge alignment stable at >= 2 tolerances.
- The 2 MED links lack Rx and stability. MED needs xday + exclusivity + n >= 5 (my reading of ruling 201, flagged).

## PLACEBO ARM (ruling 201: report it next to every real count)
Every doctor time (PQM consults and Rx) shifted by a WRONG number of hours (+4 / -4), everything else identical:
| | groups | cross-day | staff candidates | xday+excl+n5 | HIGH | MED | median timing excess (chosen pair) |
|---|---|---|---|---|---|---|---|
| real | 77 | 20 | 17 | 3 | 1 | 2 | 0.293 |
| placebo +4 h | 68 | 20 | 15 | 3 | 1 | 2 | 0.138 |
| placebo -4 h | 62 | 18 | 13 | 4 | 0 | 4 | 0.242 |
**The tiering does not beat chance at the count level**: shifted times give the same number of cross-day exclusive links (3-4) and 1 HIGH / 2-4 MED. The doctors named differ between real and placebo (the assignment is driven by timing), but consistency across two days for a doctor-voice pair happens by chance about as often as it does for real. The timing excess itself is higher in real than in placebo (0.29 vs 0.14 / 0.24), a modest gap. **V's review of the HIGH/MED cards is the real precision test.**
Edge criterion (lx's, all 1,114 doctor-room pairs, 18-24 Sep): real passes before/after mutual exclusivity per tolerance 29/48/63 and 13/22/28; Reading A 17 pairs (14 with n >= 5); placebo (+-4, +-5 h): 11-17 / 20-26 / 27-34 and 9-11 / 8-18 / 14-20; Reading A 7-12. About half of the passers are chance (as lx measured on 23 Sep). Reading B: 3 vs 2-5. `pilot/edge-placebo-summary.json`.

## Sparse (CPU, 2 turns/min, voice-lab-1) vs dense (T4, every turn >= 1.5 s)
Ruling 219 B moved ECAPA to the box T4. GPU embeddings equal the CPU ones (same turns, cos median 1.000, min 0.983, mean 0.9997), 41 room-days in 24 min instead of hours. Sparse baseline (kept, `glinks` on voice-lab-1): 103 voices, 38 groups, 14 cross-day, 12 staff candidates, 2 xday+excl+n5, 0 HIGH / 2 MED. Dense finds more voices and groups (158 / 77) and one HIGH; the dense set is the one on the page.

## Jev on the three cross-day links (frozen LQ 04545aae3478 + Q1 + paired control, de-id, nice 15)
HIGH link: Q1 doctor 0.94, LQ 0.71 but control 0.71, LQ VOID. g032 (MED): Q1 doctor 0.90, LQ 0.66 / control 0.65, VOID. g000 (MED): Q1 cannot tell 0.30, LQ 0.26 / 0.10. Same failure as the pilot (ruling 203 report, bus #992): LQ says yes whatever item list is attached. Jev is a report field on the cards, not a tier term.

## Disclosures (choices to refute)
- Clusters: average linkage, cut at cos 0.30 (set once from one unlabelled day's pair-cosine distribution, fixed for all runs), core >= 0.45; top 4 clusters with >= 25 core turns per room-day. Embeddings: turns >= 1.5 s, first 5 s; batches by length, GPU (checked against CPU).
- A voice's best doctor = highest voice-timing excess among doctors with >= 3 room-active consults and >= 30 in-consult minutes. Exclusivity = every member voice of a group names the same best doctor and no competing link in one room-day.
- n5 = >= 5 core turns of the voice inside the doctor's consults. Rx = >= 1 English-script drug/test word said by the voice in the Rx window; Rx-or-LQ yes; stability Reading A with my STRICTER mutual exclusivity (a doctor passing in two rooms on the same date is dropped from both, even if the hours do not overlap; lx drops only overlapping hours).
- Clips (per turn, single speaker, 4-5 s, cos >= 0.60 to the voice, seeded): 30 of the 60 link cards have clips from fewer than 3 different consults, only 5 have clips from >= 2 days (the eligible pool is small); the contrast clip is a turn of another voice with cos < 0.30. HIGH/MED cards are not padded; LOW controls are drawn in seeded order.
- Not done: Jev on the 57 LOW cards (no tier need); 'Same person?' pairs only 1 (few clean cross-day non-staff groups); timing is a report field, not on the cards as 'matched': the evidence text gives the minute-share numbers, no tier or cluster id.
- Ops: de-id runs at nice 15 with OMP 4 (ruling 225); an earlier LQ diagnostic left a de-id child that shared temp file names with a Jev run: killed, temp files are now per-process, the Jev runs were redone. The 10 pilot Jev runs pre-date the diagnostic and are unaffected.

## Reproduce (box, venv-gpu for numpy/torch)
stage.py, pqm_pull.py (lx), rx_pull.py (mb-rx join), edge.py (+ PLACEBO_H), fetch_pilot.py -> embed_gpu.py -> voicelink.py (+ PLACEBO_H) -> overnight_groups.py -> overnight_jevin.py -> jev_groups.py -> overnight_cards.py -> finalize_night.py. Orchestrator for the CPU baseline: orch.py.
