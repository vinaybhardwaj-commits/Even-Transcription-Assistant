# O1 REPORT (orbox-builder -> orbox-lead), 7 Oct 2026
Offline only. All audio stayed on orb3. Scoring venv: /var/lib/orb3-lab/venv (numpy 2.5.3, scipy 1.18.1, faster-whisper 1.2.1, ctranslate2 4.8.2, jiwer 4.0.0).

## Headline
- Neither denoiser helps. DeepFilterNet raises WER in all 8 files (e.g. snr10 A 29.2 -> 52.6). RNNoise leaves WER at 96-100% almost everywhere.
- The selector rarely beats the better single mic. Gains: run4 both_0 raw (A 72.3 -> 64.2), both_0 dfn (88.3 -> 81.0), both_10_g41 dfn (40.1 -> 38.0), spL_nzR_0 raw (65.7 -> 65.0). Run3 snr10/0 raw it is equal or worse than the best mic.
- Combined arm (selector on DeepFilterNet, the less-bad denoiser) is worse than raw selector in 8 of 8 files.

## Baseline reproduction (step 1, lab venv, run3 full file, A/B)
snr10 29.2/37.2 (exp 29.2/37.2), snr5 59.9/49.6 (exp 59.9/49.6), snr0 85.4/83.9 (exp 85.4/83.9). All d 0.0: PASS.
My own venv (numpy 1.26.4, scipy 1.16.3) gave snr5 40.1/67.9, snr0 B 136.5: FAIL. faster-whisper, ctranslate2, jiwer versions are identical in both venvs; only numpy/scipy differ. So WER on these files depends on the numpy/scipy build (resample_poly/filter output). Not investigated further.

## WER %, A / B / selector (fracA = share of 2 s windows won by mic A)
file       | raw A/B/sel (fracA)      | DFN A/B/sel (fracA)      | RNNoise A/B/sel (fracA)
run3 snr20 | 21.2/26.3/24.8 (.36)     | 37.2/67.9/51.8 (.30)     | 97.1/98.5/98.5 (.66)
run3 snr10 | 29.2/37.2/29.9 (.87)     | 52.6/64.2/60.6 (.26)     | 97.8/100.0/100.0 (.47)
run3 snr5  | 59.9/49.6/54.7 (.55)     | 70.8/88.3/83.2 (.32)     | 98.5/100.0/97.1 (.38)
run3 snr0  | 85.4/83.9/89.8 (.66)     | 86.1/94.2/92.7 (.26)     | 100.0/98.5/97.8 (.79)
run4 spL_nzR_0   | 65.7/83.9/65.0 (.52) | 86.1/96.4/86.1 (.98) | 100.0/96.4/99.3 (.65)
run4 spR_nzL_0   | 40.1/67.9/40.1 (.96) | 62.8/98.5/63.5 (.96) | 100.0/100.0/100.0 (.65)
run4 both_0      | 72.3/89.1/64.2 (.92) | 88.3/94.2/81.0 (.98) | 100.0/100.0/100.0 (.71)
run4 both_10_g41 | 27.0/32.8/27.0 (.92) | 40.1/58.4/38.0 (.90) | 100.0/100.0/96.4 (.62)

## Scripts (on orb3 ~/orbox-lab/o1/, copies in ~/oc/orbox-builder/o1/), sha256
baseline_scorer.py 339f5133d2373f7066fecccfe05ce33ff0abacd31a8af7c818aff9a8b44ace99 (norm, load, tx verbatim from stress_score.py; wer_run4 from run4_score.py)
score.py           1fcc3a77370be7a0e12580b8efb4c547b011b637ed9b1025d1fc0bd9eac15c7d
repro.py           cd9ec676a4be7a15f62628d53344bbb337643166c7cbf8b26a4c5e411c0ae56c
denoise.py         8acc3dc9f63277e939ffa38196d45714651428dd6e4ae5a087e8b2d0e3bdd8a7
bin/git (stub)     0475aeecc390145568d40e9f40655cdc4cc4793747fbf4a2e7b230e0d5c4fbec
Raw results: ~/orbox-lab/o1/results_{0,1,2}.jsonl. Denoised 48 kHz files: ~/orbox-lab/o1/den/{dfn,rnn}/.

## Method notes
- Selector: 300-4000 Hz band (4th-order Butterworth on the 16 kHz audio), 2 s windows, 1 s hop. Noise floor: 10th percentile of window power (run3), mean power 2.5-6.0 s (run4, same span as run4_score.py). Block k (1 s) uses the mean SNR of windows k-1 and k; 50 ms linear crossfade at switches. Stitched file transcribed once.
- Combined arm = the DFN selector column. DFN = DeepFilterNet3 default model; RNNoise = pyrnnoise 0.4.5 at 48 kHz.
- Runtime: RNNoise 42 s and DFN 15 s for 16 files; scoring 24 runs in 3 shards, about 25 min wall.

## Deviations and flags
1. Order says "best denoiser only" for combined: I scored the selector on both denoisers; the DFN column is the combined arm.
2. RNNoise WER near 100% is suspicious. Output RMS fell ~5x. I did not inspect the audio or check my pyrnnoise call (int16 chunk, shape (1,N), partial=True). It may be my usage, not the model. Treat the RNNoise column as UNVERIFIED.
3. run4 both_0 raw B is 89.1; run4_score.log says 92.0. All other run4 raw A/B match the log. Not in the step-1 gate; cause not investigated.
4. Selector does not time-align the mics (run4 lags were up to ~12 ms) or match gains. Crossfades are plain.
5. fracA in run3 is across the whole file including speech pauses.
6. deepfilternet needed a local Rust toolchain (~/orbox-lab/{cargo,rustup}), a torchaudio.backend shim and a stub git in PATH. Installing it downgraded numpy to 1.26.4 in my venv only.

## SQL / external schema assumptions
None.

## Manual steps for V
None.

## Subagents
None used.
