# ETA C3 — emotion: build report

**Ships dormant. Shipped is not working.** C3 cannot be validated until room diarization runs:
`room_turn_speaker` is empty in production while `ROOM_DIARIZE_ENABLED` is unset, and emotion reads
its speakers from that table. Turning on `EMOTION_ENABLED` alone scores nothing. Both
`EMOTION_ENABLED` and `EMOTION_SURFACE_ENABLED` are unset. No migration has been applied.

## What was built
- **Job kind `emotion_window`** — its own job, never part of diarize. Steps: prepare → warm → score
  (one service call per step, ≤ 16 segments) → finish. Every failure is recorded on
  `room_emotion_window` and named; it never throws out of the kind.
- **Migration 0089** — `room_span_emotion` (one row per segment: all seven scores, `labels_json`
  verbatim, top label, model, model_key, subfolder, device, inference_s, duration_s, the cap in force,
  window, diarize attempt, speaker index, the source_refs merged into the run, the clip key and clip
  offsets for review) and `room_emotion_window` (state, bounded retry, warm-up record, counts). No
  identity or role column.
- **Enqueue** — `/api/admin/emotion-windows`, its own cron every 5 minutes, one window at a time,
  nothing while any `emotion_window` job is queued or running. Retries a failed window to 3 attempts
  per diarize attempt; re-scores when diarize re-runs.
- **Flags** — one shared parser (`lib/flags.ts`) now used by `ROOM_DIARIZE_ENABLED`, `EMOTION_ENABLED`
  and `EMOTION_SURFACE_ENABLED`: `1|true|yes|on` enable, `0|false|no|off|empty|unset` disable, anything
  else throws. `canSurfaceEmotion()` needs both flags; a test states nothing calls it yet.
- **`emotion_clip` stub deleted** — `emotion_window` implements emotion; two kinds for one job is two
  places to be wrong.

## Mini endpoint (additive; the existing endpoints are untouched)
`POST https://emotion.llmvinayminihome.uk/inference/wavlm/segments` — `~/eta-emotion/app.py`, backup
at `~/eta-emotion/app.py.bak-segments-20260913144128`. The diff against the backup removes no line.

Request (JSON): `{ "audio_url": "<https presigned GET>", "segments": [{ "start_s": n, "end_s": n }, …] }`
- `audio_url` must be https on a host ending `.r2.cloudflarestorage.com`
  (`EMOTION_AUDIO_URL_HOST_SUFFIXES`); redirects are refused; at most 200 MB; 60 s fetch timeout. The
  service is behind a public hostname and must not fetch arbitrary URLs.
- 1 to 16 segments (`EMOTION_SEGMENTS_MAX`); numeric, finite, `0 <= start_s < end_s`.

Behaviour: fetch ONCE, decode ONCE (ffmpeg → 16 kHz mono), slice in memory, score each segment with
wavlm, answer in request order. Per segment, before inference: longer than `max_duration_s` →
`segment_longer_than_max_duration_s` (REFUSED, never truncated); past the decoded audio (0.05 s
slack) → `segment_beyond_audio`; under 0.1 s → `segment_too_short_for_model`. Never loads emotion2vec.

Response: `{ ok, model_key:"wavlm", model, device, subfolder, max_duration_s, max_segments,
audio_bytes, audio_duration_s, fetch_s, decode_s, results:[{ index, start_s, end_s, ok, labels, top,
duration_s, inference_s } | { index, start_s, end_s, ok:false, error }] }`. 400 for a malformed request
or a disallowed URL; 502 `fetch_failed: <ExceptionType>` (the URL is never echoed); 200 ok:false for a
decode or inference failure.

**Restart:** once, deliberately, 13 Sep 2026 09:14:05Z (`launchctl kickstart -k
gui/501/uk.llmvinayminihome.emotion`). `/health` answered `loaded:true` at t+22 s; the log shows
wavlm ready in 8.3 s (eager, int8). Before the restart **emotion2vec was loaded** in the running
process (not by this build); after it, emotion2vec is not loaded and available RAM rose from 1,297 MB
to 2,362 MB. First call after restart 0.54 s inference (the model's eager load runs a dummy pass, so
the ~35 s cold start did not recur); second call 0.11 s.

**Live test** through the tunnel on a real 300 s session chunk (1.19 MB): fetch 1.0 s, decode 0.9 s,
16 segments × 18.8 s scored in 8.3 s inference (max 1.46 s per segment), 10.6 s end to end. Over-cap
segments refused by name.

## Truncate vs refuse — read from the source, not probed
`/inference` refuses (400) when ffprobe measures the decoded audio over `max_duration_s`. But
`ffprobe_duration` returns 0.0 on any error, which passes that check, and the decoded array is then
**silently truncated** to the cap. The new endpoint does not rely on either: it checks every
segment's length itself and refuses.

## Measurements
**Floor** — 1, 2, 3, 5, 10 s cuts of real clinician enrolment audio, 4 speakers × 6 offsets, through
`/inference/wavlm` (119 of 120 calls succeeded; one 10 s cut failed in the service's ffmpeg):

| length | median inference_s | mean top score | entropy (norm.) | top = neutral | total variation vs 10 s | top label = 10 s top |
|---|---|---|---|---|---|---|
| 1 s | 0.61 | 0.638 | 0.561 | 0.83 | 0.297 | 0.78 |
| 2 s | 1.29 | 0.701 | 0.508 | 0.88 | 0.218 | 0.87 |
| 3 s | 2.69 | 0.710 | 0.496 | 0.92 | 0.158 | 0.96 |
| 5 s | 3.72 | 0.711 | 0.495 | 0.88 | 0.133 | 0.91 |
| 10 s | 3.93 | 0.718 | 0.483 | 0.96 | — | — |

The output does not go degenerate at any length: at 1 s it still varies with the audio (sd of the
neutral score 0.239, the same as at 3 s) and is not flat. Short clips disagree more with their 10 s
context. **By the ruling — no degenerate length — there is no floor.** Every row stores `duration_s`.
Limit: enrolment audio is read speech, 83–96 % neutral here, so this does not show behaviour on
affect-varied speech. Inference time rises with length up to about 5 s and is flat beyond it.

**Segments per window** — measured on the one real 826 s OPD window with captured /diarize output
(95 speaker segments, 15 overlap-flagged, 3 speakers): 80 runs unmerged, 48 at a 1 s gap, **38 at the
2 s gap chosen**, 32 at 5 s. After chunking at 30 s: **30 segments** — two calls at 16 per call. Merged
whisper turns cannot exceed the diarizer's speaker runs, so this is an upper bound for that window.

**Per-call cap: 16 segments.** The tunnel closes a request at 100 s. At the worst warm per-segment
inference measured (3.5 s) 16 segments is 56 s, plus fetch and decode (~2 s each) — about 60 s, with
room to wait on the service's inference lock behind another caller.

## What I still think is wrong
1. **The floor test used read speech.** No affect-varied clinic audio was used, because scoring real
   consultations to pick a threshold is itself the processing being ruled on. The first real window
   scored should be reviewed by ear against its rows before any interpretation is built.
2. **`_LOCK` serialises inference service-wide**, so an emotion batch and any other caller of the
   emotion service queue behind each other. Only this pipeline calls it today.
3. **The Mini service is not under version control.** `~/eta-emotion` is not a git repository; the
   new endpoint exists only on the Mini's disk with a `.bak` beside it. This report is its only record.
4. **The truncation path in `/inference`** (ffprobe failure → silent truncation) is a latent defect in
   an endpoint this build was told not to modify.
5. **The e2e fake service stands in for the Mini at the fetch boundary.** The real endpoint was tested
   live by hand (above) and offline against its own code; there is no automated test that runs the
   app against the real service.
