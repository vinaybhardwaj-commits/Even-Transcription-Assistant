# LOG — ACOUSTICS (per-room acoustic profiles from existing tape)

Build and event log, newest first. Owner: acoustics (builder), eta-refuter-2 (checker).

## 27-28 Sep -- W39 CLOSED: Third Floor material speech loss found; VAD tune found no win
Session: acoustics, eta-refuter-2.
A1 (VAD-blind check): OPD 1 misses 9.4% of real speech (mild), Third Floor misses 23.7% (material). A pre-registered VAD-threshold sweep (0.5/0.35/0.2) found no win -- Third Floor needs a physical fix, not a software tune. A2 initial finding was backwards, self-corrected by eta-refuter-2: empty transcripts correlate with quieter, not noisier, windows. A real sample-mismatch bug (two exports independently drew a different chunk sample than A1) caught and fixed before publishing. Final report done.
Refs: #4415-4462, #4476-4627, #4703-4727.

## 27 Sep ~09:5x-10:3x IST — profile scripts PASS, chunk run in progress
Session: acoustics, eta-refuter-2.
Scripts built (57b0f44c) covering mic device, noise floor, speech level/SNR, clipping %, exact-zero share, spectral tilt/bandwidth and a blind RT60/C50 estimate per room, from the last 7 recorded days, numbers only. One FAIL round (SNR definition + a VAD-coverage bias, #4228) fixed and PASSed at a9be680a (#4235). Chunk run over all rooms in progress; output due ~14:00 to ~/eta-data/acoustics/ROOM-PROFILES-2026-09-27.md (+json).
Refs: #4222, #4225, #4228, #4233, #4235.
