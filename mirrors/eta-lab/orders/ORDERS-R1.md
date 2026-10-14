# ORDERS-R1 for orbox-refuter (from orbox-lead, 7 Oct 2026). Role: Refuter. Do NOT start until ~/oc/orbox-builder/O1-REPORT.md exists.

## Goal
Independently check orbox-builder's O1 results (denoise + per-window mic selector on ORB3 lab recordings). You did not build it; try to break it.

## Known facts
- Orders the builder worked from: ~/oc/orbox-builder/ORDERS-O1.md (read it fully). Its report: ~/oc/orbox-builder/O1-REPORT.md. Its scripts: ~/oc/orbox-builder/o1/ and orb3:~/orbox-lab/o1/.
- orb3 = ORBOX dev box (`ssh orb3`, user orbox3, no sudo). Source data read-only: /var/lib/orb3-lab/. Builder venv: orb3:~/orbox-lab/venv; original lab venv: /var/lib/orb3-lab/venv.
- Run3 baseline full-file WER (micA/micB): +10 29.2/37.2, +5 59.9/49.6, 0 85.4/83.9.

## Check
1. Baseline: with YOUR OWN scorer written from the method text in ORDERS-O1 (not the builder's file), using /var/lib/orb3-lab/venv, reproduce run3 snr 5 micA and micB. Must match 59.9/49.6 within 1.0 point.
2. Recompute two reported arm numbers yourself: the best-scoring denoise cell and the best-scoring selector cell in O1-REPORT. Match within 1.0 point or explain the gap.
3. Selector audit: confirm windows are 2 s with 50% overlap, noise floor computed as ordered, and that the selector never peeks at the reference text or Whisper output.
4. Denoiser audit: confirm the denoised files are the same length/sample rate as the input and that scoring used the same 80 Hz HPF + small.en settings.
5. Any claim in O1-REPORT not backed by a file on disk: list it.

## Do NOT
No edits to the builder's files, no sudo, no playback/recording, nothing under /var/lib/room-recorder, no uploads, no orb2.

## Output
~/oc/orbox-refuter/R1-VERDICT.md, max 40 lines: PASS / FAIL per check 1–5 with numbers, then an overall verdict. Post on the bus to orbox-lead: subject "R1 verdict: PASS|FAIL", body 3 lines.

## Added by orbox-lead after O1 landed (16:30)
6. RNNoise column: the builder flags it UNVERIFIED (output RMS fell ~5x, WER ~100%). Check whether the pyrnnoise call was misused (frame size, int16 scaling, sample rate, partial flush). Verdict: misuse or genuine.
7. Version sensitivity: same audio scored 59.9/49.6 in the lab venv but 40.1/67.9 with numpy 1.26/scipy 1.16. Estimate how stable a single-file WER is: rescore run3 snr5 micA with 3 tiny perturbations (e.g. 1-sample shift, +0.1 dB gain, float64 vs float32 resample) in the lab venv and report the spread. This tells us how big a WER difference must be before we believe it.
