# O3 REPORT (orbox-builder -> orbox-lead), 7 Oct 2026
Files on orb3 under ~/orbox-lab/o3/. Lab venv only (faster-whisper 1.2.1, ctranslate2 4.8.2); the venv was not modified.

## 1. Seed mechanism
- `ctranslate2.set_random_seed(seed)`, docstring "Sets the seed of random generators." (python -c print(ctranslate2.set_random_seed.__doc__); exported at /var/lib/orb3-lab/venv/lib/python3.14/site-packages/ctranslate2/__init__.py:44).
- faster-whisper 1.2.1 has no seed argument: no "seed" match in .../faster_whisper/transcribe.py. The fallback loop is at transcribe.py:1432-1445 (temperature > 0 switches to beam_size 1, sampling, best_of hypotheses).
- scorer3.py calls `set_random_seed(0)` before every transcribe (scorer3.py `score()`), so a score does not depend on earlier calls in the process. Per-segment temperature comes from `segment.temperature` (transcribe.py:59) and is stored as `temps` in every row.
- Everything else is baseline: small.en int8 CPU, beam 5, language en, condition_on_previous_text False, vad_filter False, 80 Hz HPF, float64 in. cpu_threads is set per run.

## 2. Determinism proof (det.jsonl, run_det.sh; fresh process each; run3 snr0 DFN micB)
shift | threads | rep1 | rep2 | rep3 | text sha (12) | segs with temp>0 / segs
0 | 1 | 87.59 | 87.59 | 87.59 | 08f8d076e3a4 | 5 / 12
0 | 4 | 87.59 | 87.59 | 87.59 | 08f8d076e3a4 | 5 / 12
2 | 1 | 96.35 | 96.35 | 96.35 | e13bef06170b | 12 / 14
2 | 4 | 96.35 | 96.35 | 96.35 | e13bef06170b | 12 / 14
Result: 12 of 12 runs identical within each shift, and identical across 1 and 4 threads. Text hashes match too.

## 3. Re-validation (val.log, shifts.log): run3 snr5 raw micA shift 0 = 59.85 (59.9), text sha 72642dd2e688, 1 of 6 segments fell back (temp>0).
Same value as the baseline 59.9. Both runs (val and shift 0 of the 8-shift run) give identical text.

## 4. Shift-only spread, run3 snr5 raw micA, 8 shifts, 4 threads (shifts3.jsonl)
WER by shift 0..7: 59.85, 41.61, 40.15, 56.93, 41.61, 45.26, 45.26, 45.26.
Mean 47.0, sd 7.3, min 40.1, max 59.9. Segments with temp>0 per shift: 1/6, 0/11, 6/11, 1/6, 7/12, 6/11, 6/11, 7/12.
O2's unseeded run on the same cell gave 48.0±6.6 (O2-REPORT.md, results2 jsonl). So the spread is not mostly sampling noise: it is still 7.3 with the seed fixed.
Reading it: a shift changes the segmentation (6 to 12 segments) and which segments fall back. The seed makes each score repeatable, but a 1-sample shift still gives a different draw. Shift sensitivity remains a property of the system, now measured without run-to-run noise.

## Scripts (sha256; copies in ~/oc/orbox-builder/o3/)
scorer3.py  5574221b78c417f9895dcb370b3505d5b5a7694deba0e4c4a26f7a2f1d6671fb
run_det.sh  40f71b2ef90140a005b6c76772a82ea1c69d5c0781bdf9be93fc89fee95295b5

## Wall-clock (logs)
Determinism matrix 19:55:08 to 19:58:22 = 3 min 14 s (det_start.txt, det_end.txt). 8-shift rescore 19:58:46 to 19:59:33 = 47 s (sh_start.txt, shifts.log).

## Flags
1. Determinism was shown on two inputs only (the R2 cases). Other inputs are expected to behave the same but were not run.
2. The seed fixes sampling inside one call. If code order or segmenting changes, the draws change; scores are comparable only through scorer3.py.
3. O1 and O2 numbers were made by the unseeded scorer; they were not rerun.
No SQL or schema assumptions. No manual steps. Subagents: none.
