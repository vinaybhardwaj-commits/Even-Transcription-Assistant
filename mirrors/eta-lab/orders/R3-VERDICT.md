# R3 VERDICT (orbox-refuter -> orbox-lead), 7 Oct 2026, on O3-REPORT
Work dir orb3:~/orbox-lab/r3/: my copy of scorer3.py (sha256 5574221b...71fb, matches), my runner r3run.py (e3f05ee3...ce84), r3_matrix.sh, r3_follow.sh. Raw output: r3.jsonl, r3f.jsonl, F3_shifts.log. Lab venv only. Every run is a fresh process unless marked "in-process". The builder's jsonl was not used.

## Claims
C1 Seed citation: CONFIRMED as code; the claimed effect is REFUTED (see F2).
  - ctranslate2 4.8.2 exports set_random_seed (ctranslate2/__init__.py:44). Docstring: "set_random_seed(seed: int) -> None / Sets the seed of random generators."
  - faster_whisper 1.2.1: no "seed" in any faster_whisper/*.py. The fallback loop is transcribe.py:1432; for temperature > 0 it samples (beam_size 1, sampling_temperature, :1438). Segment.temperature is at :59.
  - scorer3.py:18 calls set_random_seed(0) inside score(), and score() is the only transcribe call (lines 30/32/36). So it reseeds before every call.
C2 Determinism, builder inputs (run3 snr0 DFN micB): REFUTED. Same input sha 221c21f8dedf every time.
  - shift 0: th1 87.59 x3, th4 87.59 x3, text 08f8d076e3a4. Matches the builder.
  - shift 2: th4 96.35 x3 (e13bef06170b). th1 reps were 111.68 (text 9be1c5d61116, 22 segments, 0 fallbacks), then 96.35, 96.35.
  - Repeating th1 shift 2 six more times gave 96.35 x6. So 1 of 9 fresh single-thread runs diverged, and that run had no fallback at all.
C3 Determinism, new inputs: CONFIRMED but WEAK.
  - run4 spR_nzL_0 micA (from 6 s): 40.15 x6 (th1/th4), text 1dee6628f8cd.
  - run3 snr20 raw micB: 26.28 x6, text 52786cca9ab4.
  - Neither cell had a single segment fall back (0/10 and 0/5), so the seed was never exercised.
C4 Negative control (seed call disabled in my process; run3 snr0 DFN micB, shift 2, th1): CONFIRMED variation. 89.78 / 99.27 / 89.78; texts e18fd200e723, c197fcbe26be, e18fd200e723.
C5 Shift spread, run3 snr5 raw micA, th4: REFUTED as a shift-only spread.
  - Mine, one fresh process per shift, 0..7: 59.85, 41.61, 41.61, 41.61, 42.34, 44.53, 45.26, 46.72. Mean 45.44, sample sd 6.14.
  - The builder's: 59.85, 41.61, 40.15, 56.93, 41.61, 45.26, 45.26, 45.26 (mean 46.99, sd 7.35). Shifts 2, 3, 4, 5 and 7 differ.
  - The builder's own `scorer3.py shifts 4`, run from my copy (F3), reproduces their 8 numbers exactly. Their numbers are real, but they depend on the order of calls inside one process.
C6 Baseline, run3 snr5 raw micA shift 0: CONFIRMED. 59.85 (text 72642dd2e688) in a fresh process and in F3.

## Follow-up that decides C1/C5 (F2: same 16 kHz input scored 3x in ONE process, reseeded before each call by scorer3)
- run3 snr0 DFN micB shift 2, th4: 96.35, 89.78, 89.78. The texts are e13bef06170b, 54dade1268ee, e18fd200e723, so even the two 89.78 runs differ.
- run3 snr5 raw micA shift 3, th4: 41.61, 56.93, 44.53.
- So set_random_seed(0) before each call does NOT reset the sampling. Only the first call in a fresh process is repeatable, and not always (C2).
- O3's "a score does not depend on earlier calls" is false.

## Overall
1. scorer3 is NOT deterministic. Reseeding inside a process does not make repeat calls repeatable. Fresh processes with one score each: 29 of 30 repeated seeded runs matched (C2 12, C3 12, F1 6). The one failure had 0 fallbacks, so the seed cannot explain it (cause UNVERIFIED).
2. The builder's numbers reproduce bit for bit when the same script is rerun in the same call order. The claims built on them (determinism, a shift-only sd of 7.3) do not hold. My fresh-process shift sd is 6.1, still large.
3. Not yet usable for ranking arms. Use one score per fresh process and repeat each score (for example 3x, majority text), or find a real reset of the generators.

## Flags
1. Likely mechanism, UNVERIFIED (no ctranslate2 C++ source on orb3): set_random_seed seeds generators that are created once per thread, so it only affects the first sampling in each thread. This fits F2 and C5 (first call repeatable, later calls not).
2. The 111.68 divergence (C2) had 0 fallback segments. Something besides sampling can change the beam path. I saw it once in 9 runs. Cause unknown.
3. C3 cells never fell back, so they do not test the seed. Cells with fallbacks are where determinism fails.
4. The r3_matrix runs used r3run.py before I added the `inproc3` option. The default path (one score) is unchanged. The current sha is listed above.
