# ft-refute-ft1 REPORT: FT1 cumulative timing (Opus 5.5, global.anthropic.claude-opus-5-5, Bedrock). labels.parquet sha 0aefc00f425b (v2)
Own code work/ft1_own.py on s5-clean + 10.tsv + clusters (c60ccbea4676) + lock (52959278edd8), p3a R1/R2/R4 verbatim (490f5dc17bd3 asserted); READ 2026-10-19.
VERDICT: PASS-WITH-FIXES
Numbers frozen in work/OWN-NUMBERS.txt before I read ft1_timing.py (3b36eb5d076b). Every claimed cell reproduces exactly; 0 row mismatches vs labels.parquet (1,622/1,622 on cluster, split, specialty, event date, lag).
Matured = rx_date <= 2026-07-17 (actual span 18 Dec 2025 - 17 Jul 2026). Lag 0-82 d, so all positives fall within 90 d. Share = positive episodes with lag <= d / all matured positive episodes.

Corrected table, D+H counts only (n = Rx / episodes / positive episodes; median lag; cumulative share; Wilson 95% CI for d14):
| Group | Rx | Eps | Pos | Median | d7 | d14 (95% CI) | d21 | d30 | d60 |
|---|---|---|---|---|---|---|---|---|---|
| All | 978 | 883 | 214 | 6 | 58.4% | 76.2% (70.0-81.4) | 85.5% | 88.8% | 97.2% |
| General Surgery | 405 | 391 | 128 | 5 | 63.3% | 79.7% (71.9-85.7) | 87.5% | 90.6% | 97.7% |
| Orthopaedics | 148 | 127 | 29 | 8 | 48.3% | 72.4% (54.3-85.3) | 79.3% | 82.8% | 93.1% |
| Gynaecology | 139 | 113 | 25 | 8 | 48.0% | 68.0% (48.4-82.8) | 88.0% | 92.0% | 100% |
| Urology | 98 | 89 | 16 | **6** (lane 7) | 62.5% | 75.0% (50.5-89.8) | 87.5% | 93.8% | 100% |
| Other (pooled) | 188 | 163 | 16 | 7.5 | 50.0% | 68.8% (44.4-85.8) | 75.0% | 75.0% | 93.8% |
After day 14: 51 of 214 (23.8%). Rate: 214/978 Rx = 21.9%; 214/883 episodes = 24.2% (FT7 states both).
D only: All 736/659/150, median 6, d7 56.7%, d14 74.7% (67.2-81.0), d21 83.3%, d30 86.0%, d60 96.7%.
  GS 308/294/91 d14 78.0% (68.5-85.3); Ortho 106/90/20 75.0% (53.1-88.8); Gyn 113/91/21 66.7% (45.4-82.8); Uro 69/64/7 71.4% (35.9-91.8).

Denominator reconciliation (978 Rx to 883 episodes): the 95 matured Rx that are not anchors split into 52 later Rx in clusters with no surgery,
33 later Rx whose event is the same episode as an earlier Rx, and 10 Rx with no own event in a positive cluster. 883 episodes = 881 matured clusters + 2 clusters with 2 surgery dates.
The shares use the 214 positive episodes. The "Recommendations" column (978, 405, ...) counts Rx, not episodes. 11 immature Rx have events credited to a matured anchor.
Specialty comes from the anchor Rx's own doctor_uid (S5) through doctor_specialty.tsv. That is the Rx doctor, not the surgeon; the mapping is static and leaves 0 doctors unmapped.
  In 11 of the 214 positive episodes the contributing Rx came from more than 1 specialty; each is credited to the earliest Rx's doctor.
An Rx-level alternative (247 matured Rx with their own non-excluded event) gives median 6 and d14 77.7%, so the conclusion holds either way.

## Fixes
1. Wording: "more [misses] in Orthopaedics and Gynaecology" / "fewer in Ortho and Gyn" is not supported. The d14 CIs overlap GS. Fisher GS vs Ortho+Gyn p=0.18 (Ortho p=0.45, Gyn p=0.20).
   Say "directionally lower, not distinguishable at this n".
2. ft1_timing.py median uses lags[n//2], the upper median, which is wrong for even n: Urology prints 7, the true value is 6. The headline 6 is unaffected (n=214, both middle values are 6). Use statistics.median.
3. Add an episodes column (883/391/127/113/89) next to Rx, or label the column "Rx". Change "once per patient per surgery" to "once per RD-0 cluster per surgery date".
4. ft1_timing.py reads the raw exports in forest-funnel-join with its own record rebuilder, not s5-clean as the data note binds. Today's output is identical (1,909 Rx, 0 no_key), but switch it to s5-clean.
   Also add an explicit lag <= 90 filter. Today's max lag is 82, but nothing in the code enforces the 90-day window.
5. Window: say 18 Dec 2025 - 17 Jul 2026 (>= 94 d at 19 Oct), not "Jul 2026".
6. Minor: the lane prints Urology d7 10/16 as 62% (float half-even rounding); 62.5% is the exact value. Note for the labels refute: the 29 S5 duplicates differ in flag_proc_names (multi-procedure Rx); they are not exact copies. This has no effect.
