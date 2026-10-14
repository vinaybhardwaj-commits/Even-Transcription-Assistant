# VAD v3 — report (lab-mover, e2e box, 23–24 Sep 2026)

## Decision summary for V (24 Sep; nothing has been changed in production)
"The gate" = the `--vad` switch in the Mini's whisper-server, which throws away audio it thinks is silence before Whisper reads it. Tested with the real program and the server's own settings.
- **(a) Speech the gate throws away (measured):** **19.6 %** on the first 20 windows (all 20 lose some; 16 lose more than a tenth) and **34.4 %** on the 58-window set (57 of 58 lose some; 4 lose everything). The settings were never tuned on our data, so this is a fair test. Some of that "loss" may be pyannote.ai wrongly marking noise as speech; V's listening pack settles how much (UNMEASURED until it is answered).
- **(b) Words with vs without the gate, same model (UNMEASURED reliably):** a 12-window smoke test (hand-picked windows, English forced, no reference text) gave 4,162 different words with the gate vs 6,293 without (loop-protected); on the 5 windows the gate hits hardest, 2–21 words vs 135–373. Not safe to quote as a rate. A fair test needs random windows, the server's real language setting and a reference sample.
- **(c) Made-up text without the gate on silent windows (tiny sample):** 4 of 4 near-silent windows (0–9 s of speech in 15 min) produced text: 37–60 words that are one or two words repeated with default settings, 4–14 different words with loop protection. With the gate: 1–7 words. Rate over random silent windows: UNMEASURED.
- **(d) Recommendation (Fable and V decide):** do not keep it as it is. No retune I tested is safe: the best Silero-only setting (threshold 0.10, 2000 ms, 800 ms padding) still loses 6.6 % and 87 % on the worst window; no named-parameter retune is recommended. **Prefer turning `--vad` off** for transcription, adding loop protection (`-mc 0`) and keeping any checks that catch empty or repeated output.
  Speech kept: everything Whisper is handed (vs about 80 % and 66 % kept now). Cost: short filler text on silent windows (size on random windows UNMEASURED), and more compute and time (UNMEASURED).
- **What the TEST pass changes:** nothing here. It only tests trimming audio before pyannote.ai (a separate saving), and TEST is blocked anyway. What could change (d): V's listening answers (if pyannote.ai over-labels, the true loss is lower) and a fair (b) with the real language.

Order `orders/VAD-V3.md`. Nothing here is wired to production; no flags were changed. All figures are counts
and percentages; no patient audio or transcript text is in git. **Read "Status of the evidence" before quoting
any number.**

## Bottom line
1. **Production `--vad` loses a lot of labelled speech.** whisper.cpp + `ggml-silero-v6.2.0` at the live defaults
   (0.5 / 250 ms / 100 ms / 30 ms): **19.55 %** of pyannote.ai speech cut on the 20 bake windows (20/20 windows >2 %,
   16/20 >10 %) and **34.43 %** on the 58-window set (57/58 >2 %, 46/58 >10 %, 4 windows 100 %). Matches split-speaker's
   independent replay (20.3 %). The defaults were never tuned on our data, so the 58-window figure is a fair check.
2. **Safe trimming looks small: roughly 4–17 % of audio, DEV only.** The configs that pass every window on the DEV sets send
   83–96 % of the audio (Arm B "passes" mostly because it keeps 95.6 %, so a pass means nothing without the sent %). The oracle
   ceiling (send only pyannote.ai speech) is 72 % savings on the 58 set, so the gap between "safe" and "possible" is large and
   no VAD I tested closes it. The best-looking config on DEV, the unpadded Silero-on-denoised ∪ WebRTC-0 union, sends 83 % once
   four alignment-suspect windows are set aside (see Alignment); that is a sensitivity result, not a pass.
3. **The four Silero "outliers" are two different problems.** Two (`wwq9p6eb`, `maaacrdh`) look like pyannote.ai
   labelling non-speech as speech; two (`jk5s2tfs`, `d5aype5r`) are genuine Silero misses. Preprocessing (denoise) recovers
   most of Silero's loss but does not reach the bar at scale.
4. **The (b)/(c) transcript comparison is a smoke test only.** Decoding was forced to English (whisper-cli's default) on what
   the refuter says is Hindi/Kannada speech, on 12 non-random windows, with no reference transcript, so word counts are not comparable
   across arms. It shows that default decoding loops with or without `--vad` and that near-silent windows hallucinate a short repeated
   phrase; it cannot carry a drop-versus-retune argument. **That decision should rest on (a), the measured speech loss.**
5. **Not signed off** (`REVIEW-eta-refuter-2.md`): the TEST pass is blocked (1 eligible labelled window; ~100 are needed) and 4 DEV
   windows are misaligned or suspect. `PREREGISTRATION.md` is amended accordingly.

## Status of the evidence (read first)
- **bake20 (20 windows) is DEV forever** (refuter M6): it chose Silero's parameters, Arm B's constants, the WebRTC level
  and the preprocessing chain. It appears below for diagnosis, never as a pass/fail claim.
- **The 58-window set is also DEV**, because I picked ensemble members and pad lengths while looking at it. Arms whose
  constants were fixed on bake20 first (production defaults, Arm B, Silero base, the preprocessing chain) are legitimately
  out-of-sample there; ensemble/pad results are exploratory.
- **No TEST set exists.** eta-refuter-2 counted (read-only) 1 pyannote.ai window on 1 room-day labelled after commit `6443994` outside DEV,
  against ~100 needed, so the TEST pass is blocked and unburned. DEV room-days to exclude are listed by real id in
  `datasets/vad-v3-dev-roomdays.json` (27 room-days: 15 from bake20, 19 from the 58 set, 7 shared; the bake20 file stems do not match the
  label table's window ids, but all 20 do match `bench_window.id`). The 45-window set had a clip timing bug (K1, every clip shifted 1–3 s); it is superseded
  by the 58-window re-fetch and its file is kept only as `SUPERSEDED_run_ab_45_results_K1_timing_bug.json`.
- **Truth is imperfect.** pyannote.ai is both the teacher and an unaudited labeller (H1). Loss figures are upper bounds
  where the teacher over-labels, and lower bounds where it under-labels (M4).
- **My own errors, corrected tonight** (all pushed): (i) seven scripts scored windows sharing a room prefix against the
  first window's labels (commit `53c2b3a`); every earlier number from them was rerun and the old files are superseded;
  (ii) `avg_sent_pct` divided by 1800 s on 900 s windows (fixed, JSON corrected); (iii) the first (b)/(c) word-count pass was
  invalid (Whisper loops), see below; (iv) an early "Arm B does not generalise" alert came from the K1-shifted clips and
  was retracted; (v) bake20 windows are 1011–1800 s (mean 1758 s), not all 1800 s, so "audio sent" from scripts that divided by 1800 s
  was slightly low. Corrected bake20 sent %: production gate 33.7 (was 32.9), WebRTC agg0–3 72.8/68.3/61.8/51.3, MarbleNet 41.4/38.3/35.1,
  TEN-VAD 85.7/53.0/41.2, Whisper `no_speech` 4.8/20.3/37.6. This also **resolves the Arm B discrepancy**: 99.0 % is correct; VAD-v2's 97 % used
  the same 1800 s divisor. Loss percentages are unaffected (they are fractions of teacher speech).

## Production whisper-server gate (Fable's 22:35 arm)
Binary built on this box (never the Mini). Model `ggml-silero-v6.2.0.bin` (Fable: byte-identical to the Mini's file).
- **(a) speech loss**, scored against pyannote.ai speech, full-stem labels:

| set | overall loss | windows >2 % | windows >10 % | worst | audio passed |
|---|---:|---:|---:|---|---:|
| bake20 (DEV) | 19.55 % | 20/20 | 16/20 | jk5s2tfs 99.24 % | 32.9 % |
| 58 windows | 34.43 % | 57/58 | 46/58 | four windows 100 % | 19.4 % |

  Worst sessions on the 58 set (mean loss): `9j4z2ze3` 97 %, `bt646cgk` 95 %, `7tedad86` 92 %, `25prz6ry` 78 %, `pjk6n3qy` 75 %,
  `u6tgv52b` 74 %. Sessions that do fine: `amdxyq32` 0.6 %, `6nm7h269` 6.9 %, `6yfr8qb8` 7.9 %.
- **(b)/(c) transcripts** — 12 non-random windows (5 worst-gate, 3 best-gate, 4 near-silent), large-v3-turbo on the box T4, decode flags
  `--no-speech-thold 0.7 --suppress-nst`, language left at whisper-cli's default (en; the live server's setting was not visible).
  Counts only. The first pass (raw word counts) is **invalid**: with default context the no-VAD arm loops — one string made up 93 %
  of the segments on a dense-speech window — so `gate_transcripts_v1_default_flags_INVALID_loops.json` must not be quoted. Fair rerun,
  four arms, each distinct text counted once (`gate_transcripts_v2_results.json`):

| arm | distinct-text words | of which inside teacher speech | mean top-text share |
|---|---:|---:|---:|
| no `--vad`, default | 1,003 | 950 | 0.87 |
| no `--vad`, `-mc 0` | 6,293 | 5,440 | 0.38 |
| `--vad`, default | 3,105 | 3,103 | 0.79 |
| `--vad`, `-mc 0` | 4,162 | 4,160 | 0.73 |

  On the five windows where the gate cuts 95–99.8 % of labelled speech, no-VAD `-mc 0` yields 135–373 distinct words per window
  and production `--vad` yields 2–21. On near-silent windows (0–9 s of teacher speech) no-VAD `-mc 0` still emits 4–14 distinct
  words (a repeated 1–2 word phrase), i.e. silence hallucination is real but small; `--vad` suppresses it. `-mc 0` matters about as much
  as the VAD choice. Not measured: transcript quality (no reference transcript, no WER), and whether `-mc 0` hurts accuracy.
- **Reading for the drop-or-retune decision:** treat the transcript table as a smoke test (English-forced decoding, 12 non-random windows, no reference).
  The decision should rest on (a): the gate cuts a fifth to a third of labelled speech with no tuning on our data. Whether to drop or retune, and how to
  protect against looping and silence hallucination, is Fable's call; a fair (b) needs random windows, the live server's real language setting and a reference sample.

## Hypotheses
- **H1 — is the truth wrong on disputed spans? Partly, not measured as a rate.** Whisper large-v3 on the 12 longest
  "pyannote.ai speech / Silero near-zero" spans (3 per outlier) plus 3 controls: 4/12 read as speech, 8/12 as not; all 3 controls read as
  speech. `wwq9p6eb` 0/3 and `maaacrdh` 0/3 (teacher likely over-labels there); `jk5s2tfs` 2/3 and `d5aype5r` 2/3 (real misses; MarbleNet also
  goes 95–99 % silent on `d5aype5r`). Limits (refuter): the 12 spans were the longest, so this can falsify H1 but not estimate how often it
  holds; Whisper cannot tell clinical from TV/corridor speech. **V's blinded pack decides** (`listen_v2.html`, local).
- **H2 — is the signal unusual? Partly.** The 4 outliers have a ~17 dB higher noise floor (-36.9 vs -53.5 dBFS median) and ~7 dB worse SNR
  (8.5 vs 15.4 dB). Clipping and DC offset are negligible in both groups; roll-off is slightly higher on the outliers, which points to noise
  rather than band-limiting. `h2_results.json`.
- **H3 — does preprocessing rescue Silero? Largely yes, not enough at scale.** Noise reduction is a spectral-gating proxy
  (`noisereduce`), not DeepFilterNet/RNNoise:

| set | Silero base | + denoise | + highpass+denoise+loudnorm |
|---|---:|---:|---:|
| bake20 (DEV) | 7.46 % (13/20 >2 %, sent 49 %) | 1.20 % (4/20, sent 60 %) | 0.70 % (3/20, worst 4.8 %, sent 81 %) |
| 58 windows | 20.71 % (41/58, sent 31 %) | 6.61 % (33/58, sent 44 %) | 4.67 % (14/58, p95 47 %, worst 78 %, sent 69 %) |

  High-pass or loudness normalisation alone did essentially nothing, but that was measured only under the old buggy scoring (baseline 15.4 %
  -> 15.5 % / 15.9 %) and was not rerun after the fix (the reduced rerun kept only baseline, denoise and the three-step chain). The bake20
  baseline of 7.46 % reproduces the order's figure exactly, which validates the scoring fix.

## Leaderboard (loss = share of pyannote.ai speech cut; sent = share of audio kept)
`bake20` is DEV; `58` is DEV/exploratory for anything tuned, out-of-sample for fixed-constant arms. p95 is per-window.

| arm | bake20 overall / worst / >2 % / sent | 58: overall / p95 / worst / >2 % / sent | passes every window on 58? |
|---|---|---|:-:|
| production whisper.cpp gate | 19.55 / 99.2 / 20 / 34 % | 34.43 / — / 100 / 57 / 19 % | no |
| Silero 0.15/1200/500 | 7.46 / 90.9 / 13 / 49 % | 20.71 / 91.7 / 100 / 41 / 31 % | no |
| Silero + denoise | 1.20 / 25.8 / 4 / 60 % | 6.61 / 53.0 / 100 / 33 / 44 % | no |
| Silero + highpass+denoise+loudnorm | 0.70 / 4.8 / 3 / 81 % | 4.67 / 47.1 / 78.5 / 14 / 69 % | no |
| WebRTC agg 0 / 1 / 2 / 3 | 2.24 / 3.75 / 7.47 / 17.08 overall | 4.74 / 6.75 / 10.03 / 17.09 overall, 19/28/38/48 windows >2 % | no |
| MarbleNet 0.3 / 0.5 / 0.7 | 12.1 / 16.4 / 21.5 overall | 26.7 / 32.1 / 36.7 overall | no |
| TEN-VAD 0.3 / 0.5 / 0.7 | 0.37 / 3.93 / 11.28 overall; 0.3: worst 14 %, 2/20 >2 %, sent 86 % | 0.83 / 6.63 / 16.15 overall; 0.3: worst 47 %, 12/58 >2 %, sent 84 % | no |
| Whisper `no_speech_prob` per segment (base) | 89.95 / 61.79 / 31.02 overall, 19–20/20 fail | not run | no |
| Silero grid, 36 combos | best 6.57 overall, worst 87 %, none pass | not run | no |
| Arm A: Silero + RMS proxy (no real level log) | 1.65 worst on bake20 (VAD-v2) | 0.75 / — / 29.3 / 10 / 84.5 % | no |
| **Arm B: energy-only + 0.5 s hangover** | 0.10 / 0.55 / 0 / 99 % | **0.12 / 0.85 / 1.18 / 0 / 95.6 %** | **yes** |
| U(S_all3, B) | 0.01 / 0.12 / 0 / 99 % | 0.02 / 0.08 / 1.03 / 0 / 96.2 % | yes |
| U(S_all3, WebRTC0) | 0.12 / 0.66 / 0 / 88 % | 0.20 / 1.31 / 6.24 / 3 / 83.4 % | no |
| majority vote(S_all3, W0, B) | 0.19 / 1.06 / 0 / 88 % | 0.29 / 1.48 / 6.40 / 3 / 82.7 % | no |
| U(S_all3, W0) + pad 1.0 s | 0.00 / 0.00 / 0 / 95 % | 0.02 / 0.03 / 1.16 / 0 / **92.1 %** | yes |
| U(S_all3, W0) + pad 2.0 s | 0.00 / 0.00 / 0 / 98 % | 0.00 / 0.02 / 0.08 / 0 / 95.2 % | yes |

Dropped segments (M2) for the unpadded union: 3 on the 58 set (2 of them in the alignment-suspect `nrqthr5b_…163900000`, 1 in `wwq9p6eb`) and 1 on bake20 (`8scgjz67`); each is 0.3–0.4 s. The two outside suspect windows are in V's pack (ids withheld from git; pack reshuffled 24 Sep).

Not run: pyannote seg-3.0 unions (VAD-v2's arm C intervals were never saved, and C shares lineage with the teacher, so it would not be
independent evidence); "union + real level log" (the level log has no rows for these dates); a real neural denoiser.

## Refuter M1–M3 rescoring of the frozen candidates (`score_frozen_*.json`)
M1: only 42 of 58 windows have >=60 s of teacher speech (16 use an absolute <=2 s bar). M2: segments >=0.3 s that are >=80 % cut. M3: +-0.25 s collar.

| config (58 windows) | %-bar fails (collared) | worst collared | absolute-bar fails | dropped segments | sent |
|---|---:|---:|---:|---:|---:|
| Arm B | 0/42 | 1.35 % | 0/16 | 0 | 95.6 % |
| S_all3 alone | 10/42 | 75.0 % | 1/16 | **334 in 18 windows** | 68.6 % |
| WebRTC agg0 alone | 13/42 | 39.0 % | 2/16 | 113 in 18 windows | 65.6 % |
| U(S_all3, B) | 0/42 | 1.15 % | 0/16 | 0 | 96.2 % |
| U(S_all3, W0), no pad | 2/42 | 6.36 % | 0/16 | 3 in 2 windows | 83.4 % |
| U(S_all3, W0) + pad 1.0 s | 0/42 | 0.76 % | 0/16 | 1 in 1 window | 92.1 % |
| U(S_all3, W0) + pad 2.0 s | 0/42 | 0.0 % | 0/16 | 0 | 95.2 % |

## Alignment (added after eta-refuter-2's review; my own error chain, and theirs on K2)
The refuter's energy-envelope-vs-teacher check finds bake20 20/20 aligned (±0.2 s) and the 58 set 52/56 aligned; the exceptions are windows where the fetcher padded a
~5.6 s gap with silence, which puts the rest of the window ~5.6–5.8 s late, because the teacher labelled the gap-closed production clip (`lib/bench-join.ts:221`).
I re-implemented the check (`align_check.py`, whole window and per half): bake20 20/20 within ±0.3 s; on the 58 set the per-half check is too noisy to name windows on its own.
The objective signature is a padded gap: isolated ~5.6 s runs of exact digital silence (`digital_silence_58.json`), present in `33g2chqe` (three runs), `nrqthr5b_…163900000` and
`nrqthr5b_…165700000`. (The three `6nm7h269` windows have many short silent runs, which is a gated mic, not padded gaps.) `9j4z2ze3_…1789958700000` has a weak correlation and an
unresolved lag. **Sensitivity, not tuning:** leaving those four windows out (`alignment_excluded_58.json`), 54 windows, `score_frozen_58_sensitivity_excl4.json`:

| config (54 windows) | %-bar fails (collared) | worst collared | dropped segments | sent |
|---|---:|---:|---:|---:|
| Arm B | 0/39 | 0.82 % | 0 | 95.3 % |
| S_all3 alone | 7/39 | 75.0 % | 308 in 15 windows | 68.4 % |
| U(S_all3, B) | 0/39 | 0.11 % | 0 | 96.0 % |
| **U(S_all3, W0), no pad** | **0/39** | **0.60 %** | **1 in 1 window** | **83.4 %** |
| U(S_all3, W0) + pad 1.0 s | 0/39 | 0.0 % | 0 | 91.8 % |
| U(S_all3, W0) + pad 2.0 s | 0/39 | 0.0 % | 0 | 94.9 % |

With all 58 windows the unpadded union fails 2 %-bar windows (worst 6.4 %); after removing the four suspect windows it fails none. So the padding was not needed for the VAD, only for the
artefact, and I should not have described it as clearing real failures. Any TEST window must pass the alignment check (|lag| ≤ 0.3 s, whole and halves) before scoring and any failure is
re-fetched or excluded and reported. The refuter's K2 advice (pad gaps) was wrong; the correct rule is to reproduce `bench-join` (close gaps) or fetch the exact `clip_r2_key` object.

## M4 — does the candidate cut speech pyannote.ai missed?
Regions cut by `U(S_all3,W0)+pad1.0s` where pyannote.ai says silence (>=3 s): 588 spans. Random 6 s clips, Whisper large-v3-turbo `-mc 0`,
counts only (seed 20260924): of 40 cut-span clips, 2 produced >=6 words (speech-like), 38 produced 1–5 words, none 0; of 15 clips from
teacher-silence spans the candidate keeps, 0 produced >=6 words. Whisper always emits something on noise, so word count is a weak test;
2/40 (5 %, wide interval) is a reason to listen, not a rate. Both clips are in the pack.

## Room / mic specificity (order: per-room config if outliers are room-specific)
Failures concentrate in a few bench sessions rather than spreading evenly: production-gate loss (above), `S_all3` fails in 7 sessions
(`7tedad86` 5/7 windows, `u6tgv52b` 2/7, `nrqthr5b` 2/3, `9j4z2ze3` 2/3, `33g2chqe`, `eznumztb`, `gf2zntnq`), WebRTC agg0 fails all 7 windows of
`25prz6ry`. The unpadded union `U(S_all3,W0)` leaves only `nrqthr5b` (2/3, worst 6.2 %) and `9j4z2ze3` (1/3); as the next section shows, those residual failures are alignment artefacts, not VAD errors, so the 1.0 s pad I chose to "clear" them was partly absorbing a data defect. With 21 sessions and 1–7 windows each I cannot
separate room from mic from day, and the refuter's rule (M8) forbids per-room tuning at this size. **Not established.**

## Cost (₹/night)
Savings fraction = 1 − audio sent. Per 100 audio-hours/night: Arm B saves 4.4 h, `U(S_all3,W0)+pad1.0s` 7.9 h, `+pad2.0s` 4.8 h; the oracle ceiling
(send only pyannote.ai speech) is 71.8 h on the 58 set (64 h on bake20). Multiply by the pyannote.ai rate per audio hour, which is not in the repo
and which I did not guess. Observed volume so far: 83 labels / 20.8 audio-hours on 23 Sep, which is a labelling-experiment volume, not steady state.
Per the pre-registration the figure must be quoted at the TEST sent %, not these DEV values.

## Recommendation (for Fable / V; nothing is wired)
- **Production gate:** the measured loss supports dropping or retuning `--vad`. If dropped, add loop protection (`-mc 0` or equivalent) and a silence check;
  if retuned, none of the Silero/WebRTC/TEN/MarbleNet variants tested passes on its own. Decision and any test on the live server are Fable's.
- **pyannote.ai spend:** sample-level trimming is a small lever (roughly 4–17 % at <=2 % loss on DEV). Candidates to carry into TEST (frozen, no further
  tuning): `U(S_all3,W0)` unpadded (sends ~83 % on the alignment-clean subset, 1 dropped segment), `+pad1.0s` (~92 %), `+pad2.0s` (~95 %, 0 dropped).
  DEV cannot rank them; the TEST verdict decides, and a pass without its sent % means nothing. A larger lever, untested here, would be to skip rooms/hours with no
  activity using the level log or the schedule instead of a per-sample VAD; that is a hypothesis, not a finding.
- **Before anything is trusted:** V answers the blinded pack (score the clip drawn from the alignment-unresolved `9j4z2ze3` window separately, its id is in the local key: its "teacher says speech" condition is itself
  uncertain); a TEST pass on newly labelled, alignment-checked room-days (~100 windows, none from `datasets/vad-v3-dev-roomdays.json`) is run once by eta-refuter-2; the M4 clips are listened to.

## Not done / open
V's listening answers (pack is local: `/home/eta/vad/work/vad-v3-pack2/`, answer key separate); TEST pass; neural denoiser
(DeepFilterNet/RNNoise); real level-log Arm A; pyannote.ai price and steady-state volume; live whisper-server language/flags; the unresolved Arm B sent-% discrepancy
noted above.

## Files (`studies/2026-09-23-vad-v3/`)
`PREREGISTRATION.md`, `METHOD-REVIEW-eta-refuter-2.md`; scripts `h2_diagnostics.py`, `disputed_spans.py`, `extract_clips.py`, `h1_whisper_truth.py`, `h3_preprocessing.py`,
`run_webrtc.py`, `run_tenvad.py`, `run_marblenet.py`, `run_whisper_nospeech.py`, `run_silero_grid.py`, `run_production_gate.py`, `run_gate_transcripts.py`,
`run_ensembles.py`, `score_frozen.py`, `build_audit_and_pack.py`; results `*_results*.json`, `ensembles_*_results.json`, `score_frozen_*.json`. Superseded (pre-fix or K1) files are
named `*_v1*`/`SUPERSEDED_*`/`*_INVALID_*` or are older copies of a `*_v2` file.
