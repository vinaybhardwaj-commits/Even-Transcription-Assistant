# 26. Doctor voice check: scoring split, pre-registered before any verdict (ruling 260)
vj-refuter, 25 Sep, written at 0/62 verdicts. Page d5d1116c, seed batch1b-anchors (62 docs, 246 clips, verified in refute/25).
Key: ~/eta-data/voice-linkage/batch1b-anchored-key/{key.json, clips.json} (12 anchor clips, all enrolment_session=false, all identical to the delivered mp3).

## Strata (scored separately, never pooled)
1. KNOWN-VOICE ANCHORS (3 docs, 12 clips): these are known-answer controls. They test the rater and page, not the linker.
   - Score V's blind-first (a0) verdict only. Any verdict given after the reveal is reported but never scored.
   - Expected answer = the anchor doctor (stored-print identity, cos 0.60-0.93 on non-enrolment days).
   - Report k/3 correct; "cannot tell" counts as not correct and is reported separately.
   - If < 3/3 correct: flag the page or rater before the link stratum is read. The link result stands, with that caveat.
2. LINK CARDS (58 docs): vj-link voice groups, tiered per r201/202.
   - Per tier (HIGH/MED/LOW): V's agreement = yes / (yes + no); "cannot tell" is reported, not in the denominator.
   - Report k/n with an exact binomial 95% CI.
   - HIGH auto-accept (V addendum 18:50) needs n_rated_HIGH >= 30 AND agreement >= 95%. With fewer than 30 rated HIGH, the result is INSUFFICIENT, whatever the rate.
   - Anchored-group cards (a stored print exists) are reported as their own line inside each tier. The vote-label groups (refute/25, #1405) are reported with k/n of the vote beside V's answer.
   - The vote is a LABEL, not a gate.
3. PAIR CARD (1 doc): reported descriptively only.

## Blinding / process
- The link key is read only after the page export is frozen: copy it, take its sha256, then join.
- I do not tune thresholds, tiers or group membership after the verdicts; any change = new run with its own hashes.
- Enrolment-day clips stay excluded (0 in this seed); no leave-one-out needed.

## Addendum for BATCH 2 (surg-page's addendum seed), pre-registered 25 Sep ~06:00 IST, before batch 2 is seeded and with 0 batch-2 verdicts
Strata stay separate and are never pooled with batch 1b link agreement.
1. KNOWN-VOICE (stored print): g034 Poornima, g017 Dibyendu, g088 Ankit.
   - Blind-first a0 only.
   - Ankit is ONE unit across batches (g013 + g077 + g088): correct only if every Ankit card is right. Every answer is reported.
   - Doctors are then reported as k/6 (Banerjee, Salanki, Ankit, Poornima, Dibyendu, plus H05 below if it stays).
2. KNOWN-VOICE CANDIDATE: H05 (Manoj), only in the corrected card cleared by me (F1).
   - Scored separately from the stored-print controls, because its identity rests on a booking plus words heard.
   - A blind "yes" makes Manoj a candidate anchor for batch 3. It is not minting and not HIGH (r311).
   - A "no" or "cannot tell" is reported and closes H05.
3. ORDINARY: H04 card (272724) and the 35 LOW controls.
   - Per-tier agreement as k/n with an exact CI; "cannot tell" is reported but kept out of the denominator.
   - N1: a "yes" on H04 cannot by itself make Prathik an anchor, because all its clips are from 13 Sep OPD 7, an R3 day.
4. The batch-2 page export is frozen and hashed before I read the batch-2 keys. No thresholds, tiers or groups change after verdicts.
