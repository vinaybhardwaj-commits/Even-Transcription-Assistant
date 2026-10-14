# 27. Ruling 275: candidate anchors H04/H05, g034/g017, and the batch-2 rule (vj-refuter, 25 Sep ~01:30)
Sources, read-only:
- ~/eta-data/hist-stage1b (hist-miner: items, key, bounds, turns);
- ~/eta-data/voice-linkage/dtree (vj-link: link/emb/turns for 18-24 Sep plus earlier days).
No transcript text is quoted here.

## Why H0x matters
The linker pairs every doctor with every room of the day. For example, Prathik R pairs in Dietary Room, OPD 3, OPD 5, OPD 6, OPD 7 and Cardiology on 12 Sep. So production does not give room occupancy. A booked-procedure lexicon hit is the only independent room locator we have.

## H04: Prathik R, 12 Sep, Dietary Room (rd_mxjmu7sk), booked Left RIRS
- Lexicon: 19 of 61 segments carry rirs/stone. The texts are all distinct and span the encounter, so this is not a repetition loop.
- Voice: the encounter (21.5 min) has one voice. 80 of 116 embedded turns (670 s) sit nearest Dietary cluster 29 at cos >= 0.5; the other 36 turns reach no centroid.
- Cross-day: cluster 29 matches OPD 7 13 Sep cluster 30 at cos 0.841. That cluster is present in 12 of 12 of Prathik's consults (excess 0.525). It is also present in 9 of 17 of Raksha Madhu's.
- Against: it is a Dietary Room, and cluster 29 also co-occurs with Darshana R's 26 consults (excess 0.41 > Prathik's 0.27). A dietician counselling a stone patient fits the lexicon equally well.
- Same-day conflict: Prathik's other 12 Sep links (OPD 5 cluster 53, excess 0.60; OPD 3 cluster 134) do NOT match cluster 29 (0.22-0.23). One doctor cannot be in both rooms at once, so at least one linkage is wrong.
- Verdict: CONDITIONAL.
  - Usable as a candidate anchor only as a known-voice card that V confirms blind: cluster 29 turns from the H04 encounter against the OPD 7 13 Sep cluster 30 turns.
  - It must not become HIGH on its own authority until V says "Prathik".
  - The 12 Sep Dietary room-day is then its enrolment day and is excluded from scored cards.
  - Disclosure: the 0.841 check was run post hoc by me, before any batch-2 card existed; nothing was tuned on it.

## H05: Manoj Kumar S, 16 Sep, OPD 4 (rd_ykw2rxjj), booked right knee arthroscopy
- Lexicon: 4 distinct segments with acl/pcl/arthroscop. One is at +515 s, after completion (+297 s). The queue window is 5 min against a 10.9 min encounter; bounds are clamped.
- 16 Sep is not embedded yet (it is part of the r275 extension), so the voice cannot be checked now.
- Manoj's existing voice family:
  - OPD 4 19 Sep cluster 40 (excess 0.64), OPD 5 23 Sep cluster 62 and OPD 7 23 Sep cluster 200 (present 6 of 6) agree at cos 0.62-0.76.
  - His other linked clusters (OPD 1 19 Sep, OPD 3 9 Sep, Cardiology 22 Sep, Dietary 12 Sep) do not agree with that family (0.01-0.31).
  - OPD 5 and OPD 7 on 23 Sep are the same day in two rooms: either he moved rooms or there is staff/bleed.
- PRE-REGISTERED test, written before 16 Sep is embedded:
  - H05 PASSES if the dominant cluster of the H05 encounter (most seconds, cos >= 0.5) has cos >= 0.60 to at least 2 of {OPD 4 19 Sep cluster 40, OPD 5 23 Sep cluster 62, OPD 7 23 Sep cluster 200}.
  - Otherwise it FAILS and is dropped, with no second attempt.
  - On PASS it is a known-voice card (V confirms blind) and 16 Sep OPD 4 is excluded from scored cards.

## g034 Poornima and g017 Dibyendu known-voice cards
- The prints were already verified in refute/25: Poornima 0.76-0.79 on 8 days; Dibyendu's Meet print 0.72-0.82 on 5 days.
- The seed check is the same as batch1b: clips sha-identical to the delivered mp3, 0 enrolment-session clips, and page a0 blind-first. I run it when the seed exists.

## Batch-2 rule: what I need before cards are built (vj-link writes it; I review it)
1. HIGH = anchored identity with a per-anchor cos floor fixed in the rule before the run. Room-mic prints are compared only with room-mic audio (source-conditioned, 166 L2). Anchor and enrolment days are excluded from scored cards.
2. The vote is shown as a LABEL, with k/n and the placebo p. It never sets a tier.
3. The 14 placebo seeds are re-run on the extended set (16-17 plus 18-24 Sep) and reported with the batch.
4. Known-voice cards (3 old anchors, g034, g017, H04/H05 if they pass) form their own stratum, scored blind-first (refute/26).
5. RECOMMENDATION to Fable, NOT adopted: an anchored voice found in 2 rooms at overlapping times on one day is flagged as staff or bleed and is not HIGH. This is a physical-possibility check, not exclusivity. It is only a proposal; Fable decides.
