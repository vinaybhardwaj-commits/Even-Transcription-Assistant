# R2 VERDICT (orbox-refuter -> orbox-lead), 7 Oct 2026, on O2-REPORT
Tools: own scorer orb3:~/orbox-refuter/r1/r2.py (= my r1.py plus a shift job; sha256 e9f82207...f4a4), lab venv; own interval code ~/oc/orbox-refuter/r2/r2_intervals.py. Logs: ~/oc/orbox-refuter/r2/. The builder's files were not edited.

1. Validation. results2 jsonl, run3 snr5 raw micA shift 0 = 59.85. I reran `scorer2.py validate` and saved its output, which the builder had not: "WER 59.9, bit-identical to baseline load(): True, VALIDATE_PASS" (r2/validate_builder.log). My own float64 path also gives 59.9 (R1). PASS.
2. Three cells, picked by random.Random(20261007).sample over the 48 cells. My means over 8 shifts:
   - run3 snr20 DFN micB: 55.95 vs reported 55.9. All 8 shifts identical. PASS.
   - run3 snr5 raw selector (my own selector code): 56.56 vs 57.5, d 0.94. 7 of 8 shifts identical; shift 7 is 59.1 vs 66.4. PASS, narrowly.
   - run3 snr0 DFN micB: 96.71 vs 92.3, d 4.4. Shifts 3–7 identical; shifts 0–2 are 89.8/110.2/108.0 vs 89.1/89.8/94.2. FAIL.
   Cause (NEW, affects O1, O2 and my R1): the scorer is not deterministic. faster-whisper's default temperature is [0.0, 0.2, ... 1.0]; on a bad segment it falls back to random sampling. The same 16 kHz input (same sha256) scored single-threaded twice gives 112.4, then 92.7. At 4 threads, 3 runs give 89.8/86.9/88.3 for shift 0 and 108.0/89.8/98.5 for shift 2. With temperature=0.0 only, 3/3 runs are identical, but WER is 123.4 and 132.1 because of repetition loops (determinism*.log). The gap is decoder randomness, not a builder error.
3. Float64 path. scorer2.read48() reads raw and DFN files with dtype float64; both then go through loadarr() (resample_poly 1/3, 80 Hz HPF, float32 cast), the same function as baseline. The DFN files are O1's float32-stored files, upcast. PASS.
4. Intervals. I recomputed all 32 paired differences (16 selector-vs-better-mic, 16 DFN-raw) from the 128 jsonl rows, independently: 0 duplicates, 64/64 cells complete. Every mean, interval and REAL/NOT-SHOWN label matches analysis2.md and O2-REPORT. No label is wrong. Extra: "combined arm not better than raw selector" was argued from means only. Paired, DFN selector − raw selector is REAL worse in 8/8 files (+7.7 to +25.8). PASS.
5. Claims with no file behind them, or wrong:
   - The validation line had no log. It is now backed by my rerun (check 1).
   - Flag 3, "They show sensitivity to shift": WRONG as stated. Each shift's WER also contains decoder sampling noise (check 2), so the sd is shift plus sampling, and the pairing by shift does not pair the random draws.
   - The wall clock (start.txt 17:08:05, last SCORE2_DONE 17:43:25 = 35 min) is backed. 128 copies is backed. All table cells match the jsonl.
   One wrong claim, one unlogged claim. FAIL (minor).

## Correction to my R1
R1 check 7 attributed the 21-point spread on snr5 micA to 1-sample shift, ±0.1 dB and float32 perturbations. Part or all of that spread may be decoder sampling. Why R1's cells matched exactly is UNVERIFIED (probably no fallback fired on them). The R1 conclusion "single-file WER is too noisy to rank arms" stands. The attribution "tiny perturbations cause it" is not shown.

## Overall: PASS on O2's data and conclusions, with a scorer flag.
- The builder's numbers, intervals and labels are correct. The float64 fix is in. The DFN harm is REAL in 15/16 mic files and is large compared with the noise. The selector is not shown to help anywhere, and it is REAL worse in run3 snr20 and snr5. These hold because the sd already includes the sampling noise.
- Check 2 fails on one cell. The cause is in the baseline scorer, not in O2.
- Next step: make the scorer deterministic, for example by fixing the sampling seed (whether faster-whisper 1.2.1 exposes a seed is UNVERIFIED) or keeping fallback while recording which segments fell back, and decide whether temperature fallback is part of the system under test. Then a shift test measures shift alone.
