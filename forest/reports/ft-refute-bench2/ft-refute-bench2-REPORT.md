# ft-refute-bench2 REPORT: lane ft-bench, R1 (HEAD 2d8a0c0) + R2 (HEAD cb9940f code; eb5bed7 = cb9940f + test_bench_ext.py only). Refuter Claude Opus 5.5 (Bedrock), 20 Oct 2026, R2 at 07:20 IST. D only.
Full R1 report: .bc/ft-refute-bench2-REPORT-R1.md (R1 verdict PASS-WITH-FIXES, 10 fixes). Own numbers: work/OWN-NUMBERS.txt. R2 checks: work/killers2.py + inline.
VERDICT: R2 PASS-WITH-FIXES (wording only). Fixes 1-10 are verified in code and data; layer 8 (opus_screen2) is cleared to enter. Three one-line wording edits remain (A-C below).
Tests at eb5bed7: test_bench.py 7/7; landed test_bench_ext.py 56/56, 0 xfail (rerun by me; the xfail removal is justified, screen2 is covered by the 0-hit and regex tests). My mutants: 13/16 killed (M13 fold seed now killed by the fix-5 tests; 3 survivors are equivalent on this data). Bedrock: 30/40 (no new calls in R2).
## R1 summary (details in REPORT-R1)
- No temporal leak: my own rebuild equals the lane inputs on 2010/2010 rows. A1-A4 and A6-A7 PASS.
- A5: pre-auth/insurance/payment talk is temporally legitimate, but it is an f07-type outcome proxy.
  - The v1 screen missed insurance/TPA, and its call numbering leaked which calls were dropped.
  - That proxy, not patient intent, carried the T3 Opus lead.
## R2 check (HEAD cb9940f; outputs 06:54-07:12)
- Rebuild. A sandbox build of the HEAD code is byte-identical to every lane file:
  - inputs, lag1, consult, screen, screen2, c_screen and c_screen2;
  - bench_layer8 and bench_layer8_c.
  - The base inputs are unchanged from R1. My killer checks (own call set, days, flags, whole calls, regex hits) pass on all 5 B variants.
- Fix 1 renumbering: 0 numbering gaps in screen and screen2 (2010 rows each), so a gap-only score has AUC 0.5.
  - Screen v1 was rescored on the renumbered text: 456/456 rows, chars equal inputs, the old file kept as .v0. It moved by <= 0.01.
- Fix 2 insurance category: in Latin and native script (leak_audit.py:18). Screen2 text has 0 regex hits over all 5 categories; insurance words are at 0%/0%.
  - My broader money words (cost, bill, package, rupees, estimate) are now balanced: ale T3 21% vs 22%; h14 T3 29% vs 22%.
- Screen2 vs forest: my AUCs and bootstrap reproduce the lane's claims exactly.

  | label | T | n / pos | Opus | forest | Δ forest − Opus [CI] |
  |---|---|---|---|---|---|
  | ale | 3 | 190/19 | 0.693 | 0.658 | −0.036 [−0.191, +0.108] |
  | h14 | 3 | 175/14 | 0.699 | 0.691 | −0.008 [−0.176, +0.150] |
  | h90 | 3 | 50/12 | 0.737 | 0.566 | −0.171 [−0.407, +0.071] |
  | ale | 7 | 217/12 | 0.828 | 0.763 | −0.066 [−0.212, +0.100] |
  | h14 | 7 | 204/11 | 0.825 | 0.781 | −0.044 [−0.187, +0.126] |
  | h90 | 7 | 65/12 | 0.770 | 0.585 | −0.185 [−0.419, +0.056] |

  - Every CI spans 0.
- Layer 8 B: 1952 keys = the FTR v2 at-risk union. has_text_screen2 is 407 with 0 mismatches; opus_screen2_p14/p90 have 0 mismatches vs scores_screen2_opus.
  - Screen2 rows are a subset of the screen1 rows, which are a subset of the text rows.
- Layer 8 C: 198 = designC_cohort. has_text_screen2 is 189, with 0 mismatches in either p column.
- Fix 3/4 wording:
  - LEAK-AUDIT v2 verdict, the DONE headline caveat and the 0.59 (rows removed) vs 0.69 (screened text) separation are correct.
  - The h90 T7 wording is corrected, and the "31% vs 3%" figure is replaced by all-row shares.
- Fix 5: calib folds reproduce the stored FTR OOF (the fix-5 tests kill my M13). Fix 6: the variant, C and layer-8 tests are present.
- Fix 7: the any-record OR rule is applied (bench_inputs.py:96, bench_score.py:64). 0 used calls change; 1 intent code changes; Holm now has 2 survivors, both in the forest's favour.
- Fix 8: I reproduce the ts_is_call_day=0 sensitivity: ale T3 260 rows, 0.794 vs 0.658; h14 0.815 vs 0.677.
- Fix 9: Addenda 4-6 are labelled post-hoc (DONE.md:104-109). Fix 10: one ts format in intent_codes; all bench files are 0600.
## Remaining (A-C wording, required; D-F notes)
A. Spec line 41: "h90 holds" is wrong for the screen2 primary. Write "h90 keeps a point lead (Δ −0.17) but its CI spans 0". Also say that matching consult TURNS are dropped, not whole consults.
B. DONE.md:66, stray bullet "The Δ CIs exclude 0": it sits under the screen-v2 bullet that says every CI spans 0. Move it to the original-text bullet, or delete it.
C. LEAK-AUDIT §4 quotes design C screen2 "0.751 (131/23)". 0.751 is the ALL population (n138); covered n131 is 0.749 [0.648, 0.844].
D. Note: design C screen2 rises from 0.692 to 0.749 after removing text. It is a single run, and C re-ask noise is larger (r 0.963, max |Δp| 0.30). Report it as unexplained; do not read it as gain.
E. Note: the broad date_fix words (weekdays/tomorrow/date) survive screen2: h90 T3 58% vs 21%, T7 64-67% vs 41-42%. Book/slot/schedule words are balanced or reversed at ale/h14. Report as a residual possible scheduling signal; it is not a blocker.
F. Tests lane: no layer-8 test covers the opus_screen2_* or has_text_screen2 columns (I verified them by hand above). Add them to test_bench_ext.py. (The strict xfail is resolved at eb5bed7.)
