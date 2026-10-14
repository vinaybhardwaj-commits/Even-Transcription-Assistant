# Phase L: placebo suite, complete linkage, dominance (vj-refuter P1-P4), vj-link 24 Sep night

Data: the 41 dense 18-24 Sep room-days (batch 1). No names, no text. `overnight/placebo/placebo-summary.json` has every number; `placebo_suite.sh`, `placebo_summary.py`, `tiering.py` (GROUP_MODE), `voicelink.py` / `edge.py` (PLACEBO_H, PLACEBO_DOFF) reproduce it.

## What was run
- **P1 stronger placebo, 14 full-pipeline runs**: every doctor time (PQM consults and Rx) shifted by a wrong number of hours (+-4, +-5, +-6, +-7 h) and 6 DATE offsets (another date's consults and Rx moved onto this day; same kind of date only). Each placebo re-runs voicelink (voice timing, best doctor, Rx by voice), the edge alignment, the grouping and the tiering. Smallest possible empirical p = 1/15 = 0.067.
- **P2**: complete-linkage grouping (every pair in a group has voice-centroid cos >= 0.85) beside the original single linkage.
- **P3**: does the linked voice hold the MOST speech time in the doctor's consults (rank 1 among the room-day's voices)?
- **P4**: mean Rx-by-voice hits per group under placebo = the base rate.

## Result (complete linkage; single linkage in the json gives the same picture)
| measure | real | placebo min / median / max | p |
|---|---|---|---|
| median voice-timing excess of the chosen pair | 0.296 | 0.089 / 0.152 / 0.277 | 0.067 |
| mean Rx words said by the voice (P4 base rate) | 0.22 | 0 / 0.05 / 0.12 | 0.067 |
| groups with an Rx hit | 10 | 0 / 4 / 7 | 0.067 |
| groups stable at >= 2 edge tolerances (Reading A) | 11 | 0 / 3 / 6 | 0.067 |
| cross-day groups | 23 | 20 / 21.5 / 24 | 0.33 |
| cross-day + exclusive + n >= 5 | 3 | 2 / 4 / 7 | 0.87 |
| HIGH / MED (before Jev) | 1 / 2 | 0-1 / 2-7 | 0.13 / 1.0 |
| dominant voice among cross-day exclusive links (P3) | 100% | 0 / 58% / 100% | 0.27 |
| staff candidates among cross-day groups | 20 of 23 | 11 / 16.5 / 20 | 0.13 |

## Reading
1. **The timing-to-doctor signal is real but modest.** Excess, Rx words said by the voice, and edge stability beat all 14 placebos (p at its minimum). Rx base rate under placebo is 0.05 per group against 0.22 real: prescriptions ARE named more by the right voice, about 4x the chance level.
2. **The TIER COUNTS are not above chance.** 3 cross-day exclusive links (2-7 under placebo), 1 HIGH (0-1), 2 MED (2-7). A doctor label agreeing across two days for one voice happens by chance about as often as it does for real. The precision of HIGH/MED can only come from V's review. No auto-accept on this evidence.
3. **P2**: the same 1 HIGH + 2 MED links come out under complete linkage (batch 1 stands). The largest group is still 27 room-days naming 15 doctors (31 / 16 under single linkage): a real uniform voice at cos >= 0.85 on every pair (announcement, ambient or shared source), a staff candidate by construction. Staff candidates rise from 17 to 20 of 23 cross-day groups.
4. **P3**: all three HIGH/MED links are the dominant speaker in the doctor's consults (rank 1). Not discriminating by itself (placebo median 58%, max 100%).
5. Caveat: 14 placebos give p no smaller than 0.067; timing excess of 0.296 vs placebo max 0.277 is a thin margin.

## Addendum: the same 14 placebos on the 70 room-days 9-24 Sep (00:10, vj-link)
Complete linkage, real vs 14 full-pipeline placebos (hour shifts +-4..+-7 and 6 date offsets; date offsets stay inside dates of the same kind, with or without production text). `overnight/placebo70/placebo-summary-70rd.json`.
| measure | real | placebo min / median / max | p |
|---|---|---|---|
| median voice-timing excess (chosen pair) | 0.29 | 0.076 / 0.177 / 0.275 | 0.067 |
| mean Rx words said by the voice per group | 0.164 | 0 / 0.03 / 0.074 | 0.067 (about 5x the median) |
| groups with an Rx hit | 12 | 0 / 3.5 / 8 | 0.067 |
| groups stable at >= 2 edge tolerances (Reading A) | 16 | 1 / 6 / 9 | 0.067 |
| cross-day groups | 36 | 33 / 35.5 / 37 | 0.53 |
| staff candidates | 35 | 21 / 30.5 / 35 | 0.13 |
| cross-day + exclusive + n >= 5 | **1** | 1 / **4** / 8 | 1.0 |
| HIGH / MED | 0 / 1 | 0 / 0 (HIGH), 1 / 4 / 8 (MED) | 1.0 |
Reading: the timing-derived evidence (excess, Rx-by-voice, edge stability) beats every placebo, again at the smallest possible p. The tier count does not: the real run has FEWER cross-day exclusive links (1) than the placebo median (4). Under shifted times the doctor labels collapse onto the same few busy doctors, which makes them "consistent" across days by construction, so exclusivity is met by chance more often than by real evidence. Exclusivity therefore measures busy-doctor bias, not identity. This agrees with the stored-print anchors (timing label right 47% of the time; real doctors fail exclusivity) and argues for replacing it with the anchored stratum and/or the group-vote rule.

## Addendum 2: the group VOTE rule against the same 14 placebos (vj-refuter #1403, 00:20)
Vote = plurality of a group's member voices' best timing doctors; STRICT rule = cross-day group, >= 3 of >= 4 voted days on the same doctor, share >= 40%, binomial tail vs 12.5% chance < 0.01. Groups are voice-only (the same under every placebo); only the labels change. `overnight/placebo70/vote-placebo.json`, `vote_placebo.py`.
| | real | placebo min / median / max | p |
|---|---|---|---|
| anchored groups whose plurality doctor == the anchor doctor (of 6) | **5** | 0 / 0.5 / 3 | 0.067 |
| groups passing the strict vote | 1 | 0 / 0 / 2 | 0.27 |
| passers that are anchored AND correct | 1 | 0 / 0 / 0 | 0.067 |
| passers that are anchored and WRONG | 0 | 0 / 0 / 1 | 1.0 |
| passers that are NOT anchored | 0 | 0 / 0 / 1 | 1.0 |
Reading: the vote's precision against the anchors beats all 14 placebos (5 of 6 vs at most 3 of 6, median 0.5), unlike exclusivity (real 1 vs placebo median 4). But as a GATE it is thin: it passes 1 group (g013, anchored and correct), no non-anchored group passes on the real data, and the passer COUNT is not above placebo (p 0.27; small numbers). Under placebo, no passer is ever anchored-correct (0 of 0-2). So the vote is a better doctor-label rule than exclusivity, but it cannot yet promote any group that has no stored print; for those, only more days or a second independent signal would.
