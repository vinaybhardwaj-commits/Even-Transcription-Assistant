# ORDERS-O1 for orbox-builder (from orbox-lead, 7 Oct 2026). Role: Builder.

## Goal
Measure whether (a) speech denoising and (b) a per-window mic selector improve transcription of the ORB3 lab recordings. Offline analysis only.

## Known facts
- Box: `ssh orb3` (user orbox3, NO sudo). Lab data (read-only for you): /var/lib/orb3-lab/
  - run3/micA_snr{20,10,5,0,-5}.wav, run3/micB_snr*.wav: 48 kHz mono, piper speech mixed with OT ambience, both mics gain 41.
  - run4/micA_<take>.wav, run4/micB_<take>.wav: takes in run4/takes.json. Recording offset: noise-only lead-in 1.5–6.5 s, speech 6.5–~48.7 s.
  - Reference text: speech_text.txt. Existing scorers to copy the method from: stress_score.py (run3), run4_score.py (run4).
  - Python venv with faster-whisper, jiwer, scipy, soundfile, numpy: /var/lib/orb3-lab/venv (use it; make your own venv in ~/orbox-lab if you need extra packages).
- Baseline method (keep identical so numbers compare): resample to 16 kHz, 80 Hz 4th-order high-pass, faster-whisper small.en int8 CPU, language en, beam 5, condition_on_previous_text False, vad_filter False; normalise text as in stress_score.py; WER via jiwer. For run4 transcribe from 6.0 s.
- Baseline WER, run3 full-file (micA/micB): +20 21.2/26.3, +10 29.2/37.2, +5 59.9/49.6, 0 85.4/83.9, -5 100/85.4. Run4: see /var/lib/orb3-lab/run4_score.log.

## Scope
1. Reproduce baseline for run3 snr 10, 5, 0 on both mics. If any differs by >1.0 point from the numbers above, STOP and report.
2. Denoise arm: DeepFilterNet (pip `deepfilternet`, CPU) and RNNoise (any maintained python or CLI build). Apply to the 48 kHz file before the baseline pipeline. Score run3 snr 20/10/5/0 and run4 takes spL_nzR_0, spR_nzL_0, both_0, both_10_g41, both mics.
3. Selector arm on the same files: per-mic speech-band (300–4000 Hz) SNR in 2 s windows with 50% overlap; noise floor per mic = 10th percentile of window energy (run3) or the noise-only lead-in (run4); pick the higher-SNR mic per window, stitch with 50 ms crossfades, transcribe the stitched file once. Also report the fraction of windows each mic won.
4. Combined arm: selector on denoised audio (best denoiser only).

## Allowed
Write only under ~/orbox-lab/o1/ on orb3 and ~/oc/orbox-builder/ on the Mini. pip install into your own venv.

## Do NOT
- No sudo, no systemctl, no audio playback, no recording, nothing under /var/lib/room-recorder.
- Do not modify anything in /var/lib/orb3-lab.
- Do not upload audio anywhere; everything stays on orb3.
- Do not touch orb2.

## Verify
- Baseline reproduction (step 1) passes before any arm is scored.
- Each arm's WER is computed with the exact baseline scorer function (import or copy it verbatim; show its sha256).

## Output
~/oc/orbox-builder/O1-REPORT.md on the Mini, max 60 lines: one table (file x arm: micA, micB, selector, each with/without denoise), the baseline-reproduction check, script paths + sha256, runtime. Then post on the bus to orbox-lead: subject "O1 done" + the headline in 3 lines. If blocked >20 min, post the blocker instead.
