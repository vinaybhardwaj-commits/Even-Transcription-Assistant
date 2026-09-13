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
`POST https://emotion.llmvinayminihome.uk/inference/wavlm/segments` — `~/eta-emotion/app.py`. Backups:
`app.py.bak-segments-20260913144128` (before the endpoint) and `app.py.bak-ssrf-*` (before the security
fix). Lines 1–818 — every pre-existing endpoint — are byte-identical to the original.

**SECURED 13 Sep 2026 (C3 security fix).** The first version fetched any https URL on any
`*.r2.cloudflarestorage.com` host, unauthenticated: an open SSRF and a denial-of-service amplifier on a
serialised service. It now requires, before anything is fetched:
1. `Authorization: Bearer <EMOTION_SEGMENTS_SECRET>` — constant-time compare. Unset on the service → 503
   `segments_endpoint_not_configured` for every request. Missing or wrong → 401 `unauthorised`.
2. `audio_url`: https, port 443 or none, no credentials, host EXACTLY equal to `EMOTION_AUDIO_URL_HOST`
   (our R2 bucket host, virtual-hosted, so the host names the bucket). Anything else → 400
   `audio_url_host_not_allowed` / `audio_url_not_https` / `audio_url_has_credentials` /
   `audio_url_port_not_allowed`.

Caps, each a named refusal, never a truncation: request body 64 KB; audio 25 MB
(`audio_larger_than_byte_cap`, by Content-Length and while streaming); connect 5 s, read 15 s
(`fetch_timeout`); fetch wall 30 s (`fetch_wall_clock_exceeded`); any 3xx → `fetch_redirect_refused`;
decoded audio over 1800 s → `audio_longer_than_duration_cap` (ffmpeg stops decoding at 1801 s); whole
request 85 s — segments not reached by then are refused `request_deadline_exceeded`. Per segment, as
before: over `max_duration_s` refused, past the audio refused, under 0.1 s refused. WavLM only.

Configuration: `EMOTION_SEGMENTS_SECRET` and `EMOTION_AUDIO_URL_HOST` in the launchd plist
(`~/Library/LaunchAgents/uk.llmvinayminihome.emotion.plist`, now mode 0600; pre-change copy in
`~/eta-emotion/uk.llmvinayminihome.emotion.plist.bak-ssrf-*`). The secret was generated on the Mini
into `~/.config/eta-emotion/segments-secret` (0600) and never printed. The app sends it from its own
`EMOTION_SEGMENTS_SECRET`; without it the job fails `emotion_not_configured` and makes no call.

Request (JSON): `{ "audio_url": "<https presigned GET on our bucket host>", "segments": [{ "start_s": n, "end_s": n }, …] }`,
1–16 segments. Response: `{ ok, model_key:"wavlm", model, device, subfolder, max_duration_s, max_segments,
audio_bytes, audio_duration_s, fetch_s, decode_s, results:[…] }`. 502 for a refused fetch (fixed code,
the URL never echoed), 422 for a refused decode.

**Restarts:** two in total, each deliberate — 09:14:05Z (endpoint added) and 10:35:34Z (security fix;
bootout + bootstrap so launchd re-read the environment). After the second, available RAM was 1,185 MB,
under the service's 3,500 MB eager threshold, so WavLM started LAZY; the first call loaded it (8.8 s,
9.1 s wall), the next took 0.29 s. emotion2vec not loaded after either restart.

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
