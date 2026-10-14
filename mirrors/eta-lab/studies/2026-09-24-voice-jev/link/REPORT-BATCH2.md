# Phase L batch 2 (vj-link, 25 Sep 2026): built under rule v2 (frozen 01:27 IST, sha256 ea40f81c52e1d869b70d27508bd957509f22d3dba90d6df2a8465700e783cfd4)

No names, no text, no patient data. Cards/audio on the box only; PHI-free keys in `extension/`.

## Data
80 room-days, 9-24 Sep: the 70 of 9-15 and 18-24 Sep plus 10 of 12 room-days of 16-17 Sep (segmented by pyannote 3.1 offline on the box T4 from windows rebuilt out of R2 chunks; 416 windows, 0 failures; the other 2 room-days had < 300 turns or < 8 windows). 16-17 Sep have no production transcripts: no Rx, no Jev.
Groups: complete linkage, every pair cos >= 0.85: 140 groups, 41 cross-day.

## Anchored identity on the extended set (frozen rule incl. R1 margin >= 0.15 and non-enrolment days)
7 anchored groups (member voices matching / members, own-print cos range): Banerjee 7 of 9, 0.86-0.92; Ankit (TONOR print only) 6 of 9, 0.60-0.69; Dibyendu (Meet print) 6 of 6, 0.72-0.82; Poornima 9 of 9, 0.76-0.79; Salanki 5 of 7, 0.89-0.93; Ankit 2 of 2, 0.66-0.67; **Ankit, a new 2-day group 0.62-0.63** (from 16-17 Sep). 16-17 Sep added a matching day to Banerjee, Dibyendu, Poornima and Salanki. Timing label == anchor doctor: 17 of 40 = 42% (chance about 12%). The group vote names the anchor doctor in 5 of 7.

## H05 (pre-registered test, run ONCE, PASS; ruling 311: a known-voice card for V, not HIGH)
DEVIATION from the frozen wording (found by vj-refuter, #1673): rule v2 section 4 names the called/completed window (15:30:12-15:35:09); my script used hist-miner's wider encounter bounds (15:27:12-15:38:09) and each turn's dense-cluster label. Same dominant cluster (c35) and the same cosines in both runs; no effect on the verdict.
Dominant cluster of the encounter (181 s): cos 0.918 to OPD 4 19 Sep c40, 0.684 to OPD 7 23 Sep c200, 0.559 to OPD 5 23 Sep c62. Neither the H05 voice nor the H04 voice (cluster 29) matches any of the 5 stored prints (0.15-0.27), so both are unknown people, not stored-print doctors.

## Placebos re-run on the extended set (R4; 14 full-pipeline placebos, complete linkage)
Timing-derived evidence beats every placebo again: groups stable at >= 2 edge tolerances 17 vs placebo max 13 (p 0.067); groups with an Rx hit 12 vs max 7; mean Rx words by the voice 0.129 vs max 0.063; median timing excess 0.28 vs max 0.28 (p 0.13, thin). The tier count does not: cross-day + exclusive + n >= 5 links **1 real vs placebo median 5.5 (max 9)**; MED 1 vs 5.5. Vote precision vs anchors: 5 of 7 vs placebo 0-4 (median 1.5), p 0.067; strict vote passes 1 group real (g013, anchored, correct) vs 0-3 under placebo, never anchored-correct. `overnight/placebo70/placebo-summary-80rd.json`, `vote-placebo-80rd.json`.

## The 40 cards (rolling batch of 40, all "batch": 2)
| folder | cards | what |
|---|---|---|
| batch2-anchored | 3 | Poornima (8 non-enrolment days, 0.76-0.79) and Dibyendu (5 days, 0.72-0.82, Meet print) known-voice cards, both cleared by vj-refuter (W1 wording fixed), plus the new Ankit 2-day group (0.62-0.63, weak) |
| batch2-special | 2 | H05 candidate known-voice card (proposed doctor from a booking + words heard, NOT a stored print, says so; 3 clips from OPD 4 on 22, 24 and 10 Sep, each a 4-8 s core turn of the family voice fully INSIDE the doctor's own called..completed windows (vj-refuter F1 v2); none from the 16 Sep encounter or the test's reference days (R3 read strictly); family = OPD 4 clusters with cos >= 0.60 to the encounter cluster (the frozen test's own threshold)); H04 ordinary card (OPD 7 13 Sep voice in the doctor's consults, timing guess, "not a known answer") |
| batch2-low | 35 | LOW controls: voices not on the live page (0 overlap), not anchored, not from the 12 Sep Dietary or 16 Sep OPD 4 room-days; uniform evidence v2+v3 plus the vote LABEL ("timing guess: on k of n days ... 1 in 8 by chance"); 25 single-day voices, 10 cross-day; 20 on text-less days |
Checks: `check_cards.py` OK on all three folders (3 + 2 + 35); 0 whole-word tier/confidence words; 0 id collisions among the 40 or with the live 62; 0 audio-filename collisions; keys in `batch2-*-key/` (per-clip room-day, session and cos for the anchored and special cards; 12 + 8 clips, 0 in enrolment sessions, byte-identical recompute for the anchored ones).

## Disclosures
- HIGH (anchored identity) cards in this batch are known-answer controls, scored separately (never link agreement, never an auto-accept sample); at most a handful exist.
- H04 clips: all 3 doctor clips come from ONE session (13 Sep OPD 7, the one room-day that carries the candidate voice); the anchored g088 card has clips from 2 days only; 22 of 35 LOW controls have clips from < 3 different consults; only 1 has clips from >= 2 days.
- The Poornima/Dibyendu cards were built on the 70-room-day grouping (before 16-17 Sep). The extended data adds a matching day for each; the cards state the counts they were built on (a subset), not a false number.
- 16-17 Sep segmentation used pyannote 3.1 on rebuilt windows, not production's diarizer; overlap flags come from it.
- Ops: numpy in the shared GPU venv was upgraded (1.26.4 -> 2.2.6) by installing pyannote; regression check: voicelink reproduces the same clusters and centroids.
