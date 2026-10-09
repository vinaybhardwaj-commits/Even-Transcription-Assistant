# R1 VERDICT (orbox-refuter -> orbox-lead), 7 Oct 2026, on O1-REPORT
Own scorer, written from the ORDERS-O1 method text: orb3:~/orbox-refuter/r1/r1.py (sha256 b99bcce7...4218), lab venv. Logs + copy: ~/oc/orbox-refuter/r1/. The builder's files were not touched.

1. Baseline, run3 snr5: A 59.9, B 49.6 (expected 59.9/49.6, difference 0.0). PASS.
2. Recomputed cells. Best denoise cell, run3 snr20 DFN micA: 37.2 (reported 37.2). Best selector cell, run3 snr20 raw selector: 24.8, fracA 0.36, 47 windows (reported 24.8/.36). My own selector code gives the same numbers. PASS.
3. Selector audit. Windows are 2 s with a 1 s hop (W=2F, H=F; 47 windows on 48 s). run3 noise floor is the 10th percentile of window power. run4 uses 2.5–6.0 s, which is inside the ordered 1.5–6.5 s lead-in; this is disclosed and matches run4_score.py. selector(a,b,run) uses only audio. It never calls tx() and never reads ref. PASS.
4. Denoiser audit. 32/32 denoised files: 48 kHz, mono, same frame count as their source (audit.log). Scoring uses the same 80 Hz HPF and small.en/int8/beam 5/no-VAD settings. PASS, with one FLAG: raw files load as float64, but denoised files load as float32 (score.py audio()), so resample_poly runs in float32. Check 7 shows that switch alone moves WER by 13 points. The denoise arm is therefore not scored on a bit-identical path to raw.
5. Report claims with no file behind them, or contradicted by the files:
   - "scoring ... about 25 min wall": the logs run 15:56:57 to 16:04:28, which is 7.5 min wall. The per-row seconds sum to 1151 s (19 min). WRONG.
   - "WER on these files depends on the numpy/scipy build": the version difference is real (pip list), but check 7 shows any tiny perturbation moves WER this much in one venv. The causal claim is UNBACKED.
   - "installing deepfilternet downgraded numpy": no install log on disk. UNBACKED (the versions are consistent with it).
   - Every table cell matches results_{0,1,2}.jsonl exactly. "DFN worse in all 8" and "combined worse than raw selector 8/8" are true in the data. FAIL (one wrong claim, one unbacked causal claim).
6. RNNoise: GENUINE, not misuse. pyrnnoise 0.4.5 uses 480-sample frames at 48 kHz, and the int16 scaling and partial flush are correct. My own RNNoise loop, calling librnnoise.so directly via ctypes, matches the builder's output exactly (corr 1.000 at lag 0, RMS 0.0150 vs 0.0150). On clean speech.wav it barely hurts: WER 13.9 -> 15.3, RMS unchanged, mean speech probability 0.85. On run3 snr20 micA, speech probability falls to 0.33, RMS falls 6x, and WER is 97.8. The model suppresses speech in this room/mic audio. The call is not the cause.
7. Stability, run3 snr5 micA, lab venv, one file:
   none 59.9 | 1-sample shift @48k 41.6 | +0.1 dB 43.8 | -0.1 dB 38.7 | float32 resample 46.7.
   The spread is 21.2 points (38.7–59.9), with sd about 8 points. The published baseline 59.9 is the outlier. At these SNRs a single-file WER difference under about 20 points is noise. The O1 numbers are reproducible bit for bit, but each is one sample from a wide distribution.

## Overall: FAIL on conclusions; the numbers themselves are correct.
- Every reported number reproduces exactly (checks 1, 2). The method matches the order (checks 3, 4).
- The selector "gains" (0.7–8.1 points) are all inside the measured noise. "The selector rarely helps" is also not shown. Nothing about the selector can be concluded from these runs.
- The DFN harm is larger than the noise only in some cells: snr20 A +16 / B +42, snr10 A +23 / B +27, spR B +31, both_10 B +26. Even these carry the float32 confound.
- RNNoise genuinely fails on this audio.
- Next step: average each cell over N perturbed or dithered copies (for example 5 shifts), score raw and denoised on the same float64 path, and report mean ± sd.
