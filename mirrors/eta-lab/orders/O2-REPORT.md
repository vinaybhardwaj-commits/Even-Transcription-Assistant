# O2 REPORT (orbox-builder -> orbox-lead), 7 Oct 2026
All files on orb3 under ~/orbox-lab/o2/. Lab venv only. Raw and DFN audio both read as float64, 8 integer-sample shifts (drop first s samples at 48 kHz, s=0..7, same s on both mics), baseline Whisper settings.

## Validation
run3 snr5 micA shift 0 = 59.9, and the 16 kHz array is bit-identical to baseline load(): "VALIDATE_PASS" (printed by `scorer2.py validate`, run in this session; not saved to a log file).

## Cells: WER % mean±sd over 8 shifts (source: results2_{0,1,2}.jsonl, analysis2.md)
file | raw A | raw B | raw sel | DFN A | DFN B | DFN sel
run3 snr20 | 22.3±0.7 | 36.8±16.8 | 25.5±2.0 | 36.6±1.1 | 55.9±6.8 | 51.4±2.2
run3 snr10 | 28.1±1.5 | 35.9±1.2 | 40.8±16.7 | 48.3±2.6 | 66.6±3.4 | 63.0±2.2
run3 snr5 | 48.0±6.6 | 57.7±8.4 | 57.5±4.9 | 67.5±3.5 | 84.9±5.1 | 81.3±4.2
run3 snr0 | 89.7±10.4 | 84.5±3.5 | 87.0±7.3 | 86.7±4.0 | 92.3±4.0 | 94.6±1.7
run4 spL_nzR_0 | 68.0±3.5 | 80.1±5.6 | 70.3±5.4 | 87.7±2.2 | 95.9±1.1 | 87.7±2.2
run4 spR_nzL_0 | 38.2±1.8 | 73.3±5.8 | 38.2±1.8 | 64.2±1.7 | 92.2±3.6 | 62.7±2.4
run4 both_0 | 68.6±2.2 | 89.4±5.4 | 66.1±3.8 | 81.0±4.1 | 93.6±2.3 | 81.7±3.9
run4 both_10_g41 | 25.9±1.6 | 32.8±0.9 | 25.5±1.1 | 44.1±8.6 | 67.3±10.7 | 38.3±0.7
Raw micA run3 snr5 over shifts: 41.6-59.9. Raw micA run3 snr0: up to 114.6 (insertions). Min/max for every cell are in the jsonl.

## Paired differences (same shift on both arms; mean, interval mean±2.36·sd/√8). Full list: analysis2.md
DFN - raw (positive = DFN worse): REAL worse in 15 of 16 mic-files, +4.2 to +34.5 points. NOT-SHOWN: run3 snr0 micA (-3.0, [-13.4,+7.4]).
 e.g. run3 snr10 A +20.2 [+17.8,+22.6]; B +30.7 [+27.7,+33.8]. run4 both_10_g41 A +18.2, B +34.5. run3 snr0 B +7.8 [+3.6,+12.1].
Selector - better mic (better mic = lower mean WER in that arm; negative = selector better):
comparison | mean | interval | verdict
run3 snr20 raw | +3.3 | [+1.8,+4.8] | REAL (selector worse)
run3 snr10 raw | +12.7 | [-1.5,+26.9] | NOT-SHOWN
run3 snr5 raw | +9.5 | [+2.2,+16.8] | REAL (selector worse)
run3 snr0 raw | +2.5 | [-4.2,+9.1] | NOT-SHOWN
run4 spL_nzR_0 raw | +2.4 | [-2.9,+7.6] | NOT-SHOWN
run4 spR_nzL_0 raw | 0.0 | [0.0,0.0] | NOT-SHOWN (selector = mic A)
run4 both_0 raw | -2.6 | [-6.9,+1.8] | NOT-SHOWN
run4 both_10_g41 raw | -0.5 | [-1.2,+0.3] | NOT-SHOWN
DFN selector: run3 snr20/10/5/0 REAL worse (+14.8, +14.8, +13.8, +7.9). run4 spR_nzL_0 -1.6 [-3.0,-0.1] REAL (selector better, tiny). Other three run4 DFN: NOT-SHOWN (spL 0.0 because it picks A in 98% of windows; both_0 +0.6; both_10_g41 -5.7 [-13.1,+1.6]).

## Conclusions the data supports
1. DeepFilterNet degrades small.en WER on this audio. 15 of 16 comparisons REAL, all on one float64 path.
2. The selector does not beat the better single mic in raw audio anywhere with a shown interval; in 2 run3 files it is shown worse. In run4 raw it is not distinguishable from the better mic (mostly mic A, fracA 0.51-0.96).
3. Combined arm (selector on DFN) is not better than raw selector (DFN selector column vs raw selector column above, every file higher).
Not shown: that the selector is useless. With 8 shifts the intervals are wide in the noisiest cells (run3 snr10/0).

## Scripts and sha256
scorer2.py  155114e9b03d1ba62195ce4b06c87f7feb87ae0f998024228b1e9ae595cb9fa9
analyze2.py 30440b698384527738f05a276d41f17b415e8c94f96fd7b91c64ae48b626dc5c
baseline_scorer.py (imported from ~/orbox-lab/o1, unchanged) 339f5133d2373f7066fecccfe05ce33ff0abacd31a8af7c818aff9a8b44ace99
Copies of scorer2.py and analyze2.py: ~/oc/orbox-builder/o2/.

## Wall-clock (score2_{0,1,2}.log, start.txt)
Scoring 17:08:05 to 17:43:25 = 35 min wall, 3 shards, 128 copies.

## Flags
1. Shifts perturb the start only. They do not test gain sensitivity (R1's +-0.1 dB). Not run; not ordered.
2. "Better mic" is chosen from the same 8 copies, which slightly favours the mic comparison against the selector.
3. K=8 shifts of one recording each. They show sensitivity to shift, not to a new recording. The 95% interval uses t(7)=2.36 as ordered and assumes shifts are independent.
4. The paired DFN sets differ by shift in nothing else; DFN files are those from O1 (~/orbox-lab/o1/den/dfn/), not regenerated.
No SQL or schema assumptions. No manual steps. Subagents: none.
