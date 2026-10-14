# Order — VAD v3: solve dead-air trimming properly, using every machine (23 Sep 21:25, Fable → lab-mover owner; herdr-kit data; eta-refuter-2 method review)

## What we know (20 bake windows, pyannote.ai speech = 35.8% of audio)
| arm | overall cut | worst window | audio sent |
|---|---|---|---|
| Silero tuned (0.15/1200/500) | 7.46% (2.36% w/o 4 outliers) | 91% | ~46% |
| A Silero + RMS proxy | 0.10% | 1.65% | ~90% |
| B energy only | 0.10% | 0.55% | ~97% |
| C pyannote seg-3.0 | 4.95% | >2% | ~47% |
Target: send as little audio as possible with speech loss ≤ 2% on EVERY window (and p95 ≤ 1%).

## The real question: why is Silero blind on 4 windows (19–91% missed, near-zero probabilities, normal RMS)?
Three hypotheses — test all three tonight, in parallel:
H1 **The truth is wrong there.** pyannote.ai may be labelling non-clinical sound as speech (TV/radio, corridor babble, music). Test: Whisper large-v3 on every span where Silero says silence but pyannote says speech → words/sec, no_speech_prob, avg_logprob per span (counts only, no text in reports). Plus a listening pack for V (below).
H2 **The signal is unusual.** Band-limited (e.g. 8 kHz content upsampled), heavy steady noise (AC/fan), DC offset, clipping, reverberant far-field, codec damage. Test: per-window diagnostics — spectral roll-off/bandwidth, spectral flatness, SNR estimate, noise floor, clipping %, DC — outliers vs the 16 good windows.
H3 **Silero needs preprocessing.** Test Silero after: high-pass 80 Hz; loudness normalise (-23 LUFS); denoise (DeepFilterNet3 and/or RNNoise); 8 kHz Silero model path; each alone and combined.

## Candidate VADs (run all on the same windows)
Silero v6 (+ H3 preprocessing variants) · WebRTC VAD (aggressiveness 0–3) · TEN-VAD · NeMo Frame-VAD / MarbleNet · pyannote segmentation-3.0 (onset/offset sweep) · Whisper no_speech per 30 s chunk · ensembles: union(C, Silero-preproc), union + level log, majority vote. Padding sweep for the best two.

## Scale the test set
20 windows is too few. herdr-kit: export 200 more windows that have pyannote.ai teacher labels (diarize_window_label, engine=pyannoteai), stratified across all rooms and days available (≥10 per room), audio from R2 via clip_r2_key (credentials stay on the Mini; copy audio to gcp-l4 + orbox3 under ~/eta-lab-night/vad-v3/data, 14-day cleanup), manifest in eta-lab git (ids only). Also add the per-window level-log samples so arm A uses the REAL level log, not the RMS proxy.

## Where things run (all at once)
- gcp-l4 (L4): Whisper large-v3 truth check (H1), pyannote seg sweep, NeMo VAD, DeepFilterNet. `flock ~/gpu.lock`.
- orbox3 (12-core CPU, until 06:45): Silero/WebRTC/TEN-VAD grids + preprocessing variants on the 200 windows.
- ehrc-audiometry + Mini (MPS, windows per ruling): diagnostics (H2) + Silero-after-denoise on MPS.
- eta-lab-t4: scoring/aggregation, results tables.
Use kit/lab-run.sh when herdr-kit has it; progress lines to each machine's logs/lab-mover.log (V watches in herdr).

## Listening pack for V (morning)
12 clips, 10 s each: the 12 longest "pyannote says speech, Silero says silence" spans from the 4 outliers + 3 control clips. One HTML page (audio players + two buttons each: real clinical speech / not). Clips stay on our machines; Fable opens the page on V's Air. V's answers are the ground truth for H1.

## Deliverables (by 07:00 IST)
studies/2026-09-23-vad-v3/REPORT.md: H1/H2/H3 verdicts with numbers; leaderboard (cut % overall, worst window, p95, audio sent %, per-room breakdown); recommended config OR "per-room" config if the outliers are room/mic specific; ₹/night saving at the recommended config (pyannote.ai bills per audio hour). ≤12-line summary to Fable. eta-refuter-2 reviews the method before anything is wired.

## Not allowed
No production changes, no flags. Patient audio never in git or public logs; no transcript text in reports.
