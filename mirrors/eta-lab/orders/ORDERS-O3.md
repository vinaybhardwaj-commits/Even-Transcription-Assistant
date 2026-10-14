# ORDERS-O3 for orbox-builder (from orbox-lead, 7 Oct 2026 19:25). Role: Builder.

## Why
R2 (~/oc/orbox-refuter/R2-VERDICT.md, read it) found the scorer is not deterministic: faster-whisper's temperature fallback samples randomly, so identical input can score 112.4 then 92.7. Temperature 0 alone is deterministic but loops (123–132%). Before any further comparison we need a deterministic scorer.

## Goal
scorer3: same baseline settings (small.en int8 CPU, beam 5, language en, condition_on_previous_text False, vad_filter False, 80 Hz HPF, float64 path, lab venv), but deterministic.

## Scope
1. Find out how to fix the sampling seed in the lab venv's faster-whisper 1.2.1 / ctranslate2 4.8.2 (e.g. ctranslate2.set_random_seed, or a seed argument). Cite the source line or doc you rely on (file path + line). If no seed control exists, fall back to: keep temperature fallback, record per segment which temperature was used, and report it.
2. Prove determinism: the same 16 kHz input (run3 snr0 DFN micB shift 0 and shift 2, the cases R2 used) scored 3 times in fresh processes must give identical text and WER, single-threaded and at 4 threads.
3. Re-validate: run3 snr5 micA shift 0 with scorer3. Report the value (it may legitimately differ from 59.9 now). Also report how many segments fell back to temperature > 0 per file.
4. Rescore only run3 snr5 micA over 8 shifts with scorer3 and report mean ± sd, so we know the true shift-only spread.

## Allowed / do NOT
Write only orb3:~/orbox-lab/o3/ and ~/oc/orbox-builder/ on the Mini. One action per Bash call. No sudo, playback, recording, uploads, orb2, or /var/lib/room-recorder. Do not modify the lab venv.

## Output
~/oc/orbox-builder/O3-REPORT.md, max 40 lines: seed mechanism and its source citation, determinism proof table (runs × threads), re-validation value, fallback counts, shift-only mean ± sd, sha256 of scorer3.py, wall-clock from logs. Every claim points at a file. Bus post "O3 done" to orbox-lead.
