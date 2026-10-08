# ORDERS-O2 for orbox-builder (from orbox-lead, 7 Oct 2026 17:10). Role: Builder.

## Why
orbox-refuter R1 (~/oc/orbox-refuter/R1-VERDICT.md, read it) showed your O1 numbers are exact but a single-file WER moves up to 21 points (sd ~8) under a 1-sample shift or ±0.1 dB gain. So single scores cannot rank arms. Also the denoised arm was resampled in float32 vs float64 for raw (13-point effect on its own).

## Goal
A noise-aware scorer, then rescore the O1 cells with it.

## Scope
1. scorer2.py on orb3 (~/orbox-lab/o2/), lab venv only (/var/lib/orb3-lab/venv). Every input is cast to float64 before resample/filter, for raw AND denoised audio. For each file, score K=8 perturbed copies: integer sample shifts 0..7 at 48 kHz (no gain change), same Whisper settings as baseline. Report mean, sd, min, max WER per cell. Save per-copy results to jsonl.
2. Validate: run3 snr5 micA shift-0 must equal 59.9 exactly (same path as baseline). If not, STOP and report.
3. Rescore with K=8: raw micA, raw micB, raw selector, DFN micA, DFN micB, DFN selector for run3 snr20/10/5/0 and run4 spL_nzR_0, spR_nzL_0, both_0, both_10_g41. Skip RNNoise (R1 proved it destroys this audio).
4. For each comparison (selector vs better mic; DFN vs raw, per mic) report the PAIRED difference per shift (same shift on both arms), its mean and a simple 95% interval (mean ± 2.36·sd/√8). Call a difference real only if the interval excludes 0.

## Allowed / do NOT
Same as ORDERS-O1: write only ~/orbox-lab/o2/ on orb3 and ~/oc/orbox-builder/ on the Mini; one action per Bash call; no sudo, playback, recording, uploads, orb2, or /var/lib/room-recorder.

## Output
~/oc/orbox-builder/O2-REPORT.md, max 60 lines: the validation line, one table (cell: mean ± sd), one table of paired differences with intervals and REAL/NOT-SHOWN, script sha256s, honest wall-clock time from the logs. Every claim must point at a file. Post "O2 done" to orbox-lead on the bus.
