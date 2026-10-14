# E-6.2 proposals from the 23 Sep score (lx, 23 Sep 22:40 IST, draft for Fable)

**Scope.** 3 voiceprint-confirmed room-days (Cardiology OPD, OPD 3, OPD 5), 14 PQM consults (`e7-truth-23sep.csv`). Hypotheses come from ONE Jev sample (the E-6.1 replay): acoustic 14, recall 3/14, precision 4/14; fused 8, recall 3/14, precision 3/8. Per-consult evidence was read SELECT-only (`kit/neon-select.mjs`): level log, windows and whether each was transcribed, Jev probe labels. Counts and times only.

## What happened to the 14 consults
| Outcome | n | Evidence |
|---|---|---|
| Matched | 3 | All three had transcript coverage ≥0.68, and Jev called 4–7 of their 6–8 probes clinical. |
| Missed: **no transcript at all** | 7 | All 7 fall between 12:14 and 14:14 IST, around the 12:50 STT outage. Every one was RECORDED (window coverage 1.00) and had level data (≥1 sample every minute). The acoustic gate needs stored text, so the probes are `unjudged` and no encounter can open. |
| Missed: partly transcribed | 4 | OPD 3 09:12 (transcribed 0.14), OPD 5 10:53 (0.15): too little text. OPD 3 09:41 (0.64): enough text, but only 16% of its level samples reach the fixed 0.05 energy threshold. Cardiology 12:24 (0.23): a near miss. The acoustic encounter 12:16–12:28 overlaps it 35% (< 50%), and its end is cut where the transcript stops at the outage, not by the smoother. |

**The 23 Sep recall ceiling is the outage, not the encounter clock.** Recall is 3/7 over consults with any transcript, and 3/4 over consults that are ≥ 50% transcribed. 24 Sep is the real test.

## Where acoustics over-proposed
10 acoustic encounters match no consult. All 10 are fully transcribed, and they lie 16–146 min from the confirmed doctor's nearest PQM consult. Fusion rejected 5 (0 clinical probes). It kept 5 on thin evidence: 1/5, 1/5, 1/2 and 2/7 clinical probes, plus Cardiology 12:16 at 5/10, which partly overlaps a consult. Caveat: PQM records only called tokens, so some of these may be real consults PQM never saw (for example, before the first token was called). Precision is a LOWER bound.

The earlier acoustic split (1) was removed by fusion. Signed errors on the 3 matches: start −370/+175/−103 s, end −328/−357/+109 s. There is no consistent offset (n=3).

## Proposals (ordered by evidence; none built)
1. **Clinical share in fusion, not "≥1 clinical probe".** Keep an acoustic encounter only if at least 50% of its judged probes are clinical.
   - Clinical probes / judged probes per fused encounter on 23 Sep: matches 4/4, 5/7, 5/10; unmatched 1/5, 2/7, 1/5, 1/2, 5/10.
   - "≥ 50%" drops 3 of the 5 unmatched encounters and keeps all 3 matches: precision 3/8 → 3/5, recall unchanged.
   - "> 50%" would also drop the last 2 false positives, but loses a real match (OPD 3 11:01 is exactly 5/10).
   - **Fragile:** the cut sits on a tie, with n=3 matches chosen in sample. Validate on 24 Sep before any change, and prefer a confidence-weighted share (band-weighted U6) over a raw count.
2. **Energy threshold per room-day, not a fixed `energy_active_min` 0.05.**
   - Median peak in consults vs between consults: OPD 3 0.014 vs 0.010 (75th percentile 0.026 vs 0.011); OPD 5 0.013 vs 0.011 (0.018 vs 0.012); Cardiology 0.030 vs 0.022 (0.060 vs 0.056).
   - The fixed threshold marks only 1% of OPD 5's consult samples active. A relative threshold (e.g. k × the room-day's quiet-time median) would let the gate hear OPD 5 at all. Bench it on 24 Sep full-day level data.
3. **Measure transcript coverage before scoring.** `e7-rescore` should report the share of each consult's minutes that were transcribed. Recall should be reported twice: overall, and over consults with ≥ 50% coverage. That way an STT backlog or outage is not scored as an encounter-clock miss. If STT lags the clinic, start the 21:00 run only once the day's windows are transcribed.
4. **Not recommended yet: encounters from energy alone.** Cardiology's in- and between-consult levels overlap (75th percentile 0.060 vs 0.056); back-to-back consults leave no quiet gap to split on. Revisit with 24 Sep.
5. **E-6.1 (Jev proposes) stays inert.** U2 start never reached 0.9 on 23 Sep (max 0.86), and the 7 untranscribed consults give Jev nothing to read. Do NOT lower START_P until 24 Sep shows proposals would land inside consults. The heard-probe rule (81cec3a) stays either way.

**Next for lx:** fold (3) into `e7-rescore` (coverage column and a second recall). Run the 24 Sep score. Then re-test (1) and (2) out of sample on it.
