# URGENT — production whisper-server VAD may be dropping clinical speech (split-speaker, 23 Sep 21:20 IST)

Source: lab-mover's claim (relayed via minibot/V) — the Mini's whisper-server runs Silero VAD live and
unflagged in front of STT: `--vad --vad-model for-tests-silero-v6.2.0-ggml.bin --no-speech-thold 0.7 --suppress-nst`.
Counts and window ids only below. Nothing changed by me.

## 1. Replay (E2E box, cached Silero 6.2.3 frame probs, 20 bake windows vs pyannote.ai teacher speech)
| Silero post-processing | speech lost overall | windows >2% | windows >10% | worst |
|---|---:|---:|---:|---|
| whisper.cpp defaults, assumed (thr 0.5 / min_silence 100 ms / pad 30 ms) | **20.3%** (2841/14011 s) | 20/20 | 17/20 | jk5s2tfs 99.3%, d5aype5r 95.8%, wwq9p6eb 76.5%, 9j4z2ze3 72.8% |
| lab-mover's tuned (0.15 / 1200 / 500) | 7.5% | 13/20 | 4/20 | jk5s2tfs 90.9%, d5aype5r 84.7% |

Caveats: the whisper.cpp defaults are ASSUMED, not read off the live launch (no Mini shell here), and
teacher speech includes intra-turn pauses a 30 ms pad trims, so the 20% is an upper-ish bound. It is not
the reason for a window at 99%.

## 2. Production evidence (Neon, read-only, last 7 days)
- 479 windows got silence verdict `engine_empty_transcript` (whisper returned nothing).
- 118 of them also have a diarize row; **101 are state=ok (the diarizer found speakers)**, and **31 have ≥60 s of
  diarized speech, 122 min in total**, in windows STT called empty.
- `bench_window_silence.vad_enabled` / `silero_version` are NULL on all 479, so the gate's use is not recorded.
Not separable from these data: how much comes from `--vad`, from `--no-speech-thold 0.7` and from `--suppress-nst`.

## 3. Ask (Fable's call)
1. Someone with a Mini shell reads the live whisper-server args (VAD thresholds) and checks that the "for-tests" model is real weights.
2. Re-transcribe 1–2 of the 31 windows with `--vad` OFF and compare word counts, to confirm or refute.
3. If confirmed: drop `--vad` (or apply lab-mover's params), then reopen the 31 (+ the rest of the 101) via silence readjudication.

## CORRECTION 24 Sep 00:15 IST (lab-mover, studies/2026-09-23-vad-v3/REPORT.md b8108e1; bus id 65)
- Not every outlier is a real miss. Whisper large-v3 on the longest disputed spans reads **wwq9p6eb and maaacrdh as NOT speech (0/3)**, so
  pyannote.ai likely over-labels those two and the teacher-based loss above is overstated for them. **jk5s2tfs and d5aype5r read 2/3
  real speech: those are genuine misses.** Only the longest spans were checked; V's blinded pack decides.
- On wider data it is worse, not better: **whisper.cpp defaults lose 19.6% on bake20 and 34.4% on 58 windows**. lab-mover's Silero
  0.15/1200/500 loses 20.7% on the 58 (41/58 windows >2%).
- Section 2 (101 empty-transcript windows where the diarizer found speech; 31 with ≥60 s) stands as it was: it is production data,
  not the teacher.

## UPDATE 24 Sep 06:25 IST (split-speaker)
- The Mini's whisper-server now runs **without `--vad`**: `-m ggml-large-v3-turbo.bin --no-speech-thold 0.7 --suppress-nst`, per lab-mover's
  read-only `ps` (bus #44) and "NO --vad (V ruling 24 Sep)" in orders/REDUNDANCY-R1.md. What is still OPEN is whether `--vad` was live
  while the 101 empty windows were transcribed. That decides whether they were cut by whisper-server's VAD or by the router's
  documented Silero VAD starvation (CLAUDE.md "VAD starvation"). Either way those windows need re-transcribing; which one is the cause
  changes nothing about that.
