# ORDERS-R3 (orbox-lead -> orbox-refuter), 7 Oct 2026

## Goal
Independently refute or confirm orbox-builder's O3 claims (~/oc/orbox-builder/O3-REPORT.md). You did not build scorer3.py. Rerun everything yourself; do not trust the builder's jsonl files.

## Scope (orb3 only, read + run, no edits to builder files)
Work in a NEW dir: ~/orbox-lab/r3/ on orb3. Copy scorer3.py there from ~/orbox-lab/o3/ and check its sha256 = 5574221b78c417f9895dcb370b3505d5b5a7694deba0e4c4a26f7a2f1d6671fb before use.
Use ONLY /var/lib/orb3-lab/venv/bin/python. Do not modify the venv. Do not touch room-recorder or /var/lib/orb3-lab recordings (read only).
One action per Bash call (no chained ssh+scp+write); the permission classifier blocks chains.

## Checks
C1 Seed citation. Confirm ctranslate2.set_random_seed exists in the lab venv and what it does (docstring, and ctranslate2/__init__.py line). Confirm faster_whisper/transcribe.py 1.2.1 has no seed argument and that the temperature fallback samples (cite file:line). Read scorer3.py and confirm set_random_seed(0) is called before EVERY transcribe call, not once per process.
C2 Determinism, builder's inputs. run3 snr0 DFN micB, shifts {0,2}, threads {1,4}, 3 fresh processes each (12 runs). Your own runner script. Report WER and a text sha per run. Builder claims 87.59 (shift 0) and 96.35 (shift 2), identical across reps and threads.
C3 Determinism, NEW inputs the builder did not run. Pick 2 cells not in O3: run4 micA one file, and run3 snr20 raw micB. Shift 0, threads {1,4}, 3 fresh processes each (12 runs). Must be identical within each cell.
C4 Negative control. Run one C2 cell with the seed call disabled (your copy, a flag or a sed on YOUR copy only), 3 fresh processes. Expect variation if any segment falls back. If no variation appears, say so; that weakens the proof.
C5 Shift spread. Recompute run3 snr5 raw micA, 8 shifts 0..7, 4 threads, seeded. Builder claims 59.85, 41.61, 40.15, 56.93, 41.61, 45.26, 45.26, 45.26; mean 47.0, sd 7.3. Compute mean and sample sd yourself from your numbers.
C6 Baseline. Confirm run3 snr5 raw micA shift 0 = 59.85 (baseline 59.9).

## Verdict rules
Each claim: CONFIRMED, REFUTED (with your numbers), or UNVERIFIED (could not run). Any mismatch in C2/C3 = REFUTED determinism.

## Output
Write ~/oc/orbox-refuter/R3-VERDICT.md, cap 60 lines: one line per claim C1..C6 with verdict and numbers, then a 3-line overall verdict, then flags. Keep raw outputs in ~/orbox-lab/r3/ on orb3. Final pane reply: 5 lines max. You report to orbox-lead.

## Do not
Edit builder files, rerun O1/O2, change the venv, start/stop services, send audio anywhere off orb3, or message V.
