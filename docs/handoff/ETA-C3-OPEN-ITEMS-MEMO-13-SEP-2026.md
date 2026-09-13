# ETA C3 — open items at close-out

**Date:** 13 September 2026 · **Branch:** `vinay/tier2-c3` · **Status:** C3 is built and dormant.
`EMOTION_ENABLED`, `EMOTION_SURFACE_ENABLED` and `ROOM_DIARIZE_ENABLED` are unset. Migration 0089 is
NOT applied; it applies only after a deploy carries it, via `POST /api/run-migrations` with
`Bearer $MIGRATION_SECRET` — the same order as 0088.

---

## ⚠️ GATE 1 — THE FLOOR IS UNVALIDATED ON AFFECT-VARIED SPEECH

**This is a gate, not a note. NOBODY BUILDS AN INTERPRETATION ON THESE NUMBERS until a real scored
window has been checked by ear.**

- **Condition.** The length-floor measurements (1, 2, 3, 5, 10 s cuts; 4 speakers × 6 offsets) used
  clinician ENROLMENT audio — read speech. The model called 83–96 % of those clips neutral. They show
  that short clips do not go degenerate and do disagree more with their longer context. They show
  nothing about how the model behaves on speech that carries affect.
- **What it blocks.** Any query, dashboard, alert, report or threshold that reads meaning into
  `room_span_emotion` scores — for any of the four uses (patient distress, clinician affect over time,
  consultation quality, exploratory). Computing and storing rows is not blocked (still gated by
  `EMOTION_ENABLED`); interpreting them is.
- **What lifts it.** A real window, diarized and scored, whose rows have been listened to against its
  clip (`clip_r2_key`, `clip_start_s`–`clip_end_s` on each row) by a person, with the result recorded
  in `docs/handoff/`. Until that record exists, this gate stands.

## Open item 2 — `/inference` truncates silently when ffprobe fails

- **Condition.** In `~/eta-emotion/app.py` `_run_inference`, the over-length refusal checks
  `ffprobe_duration(dst) > MAX_DURATION_S`. `ffprobe_duration` returns `0.0` on ANY exception, so a
  failed probe passes the check; the decoded array is then cut to `MAX_DURATION_S` without a word
  (`audio = audio[: int(MAX_DURATION_S * SR)]`). The caller gets `ok: true` for a clip it did not send
  in full.
- **Exposure.** Nothing in this pipeline calls `/inference`, `/inference/wavlm` or
  `/inference/emotion2vec`. The C3 path uses `/inference/wavlm/segments`, which checks every segment's
  length itself and refuses. The defect sits in endpoints this build was told not to modify.
- **Status.** Open. Named, not fixed.

## Open item 3 — inference is serialised service-wide

- **Condition.** Every inference in the emotion service runs under one module-level lock (`_LOCK` in
  `classify_wavlm` and `classify_emotion2vec`). A batch call scores its segments one after another
  inside that lock, so an emotion batch blocks every other caller of the service — any endpoint, any
  model — until it finishes, and they block it.
- **Exposure.** Only the C3 pipeline calls the service today, one window at a time. A 16-segment batch
  measured 10.6 s end to end on real audio; at the worst measured per-segment inference (3.5 s) it is
  about a minute.
- **Status.** Open.

## Open item 4 — no automated test runs the app against the real service

- **Condition.** The app's end-to-end tests (`tests/unit/c2-e2e-runner.test.ts`, C3 block) run the
  `emotion_window` job through the real runner against a real Postgres, but fake the emotion service
  at the fetch boundary with the captured response shape. The real
  `POST /inference/wavlm/segments` was tested by hand, live through the tunnel, on a real 300 s chunk,
  and offline against its own code (23 checks, model stubbed). Nothing automated exercises the app and
  the real service together, so a change to either side of that contract is caught by neither suite.
- **Status.** Open.

## Open item 5 — the consent basis is V's ruling, unverified by the Builder

- **Condition.** Emotion is scored for all speakers on V's ruling, recorded in
  `ETA-C3-EMOTION-CONSENT-DECISION-MEMO-13-SEP-2026.md`, quoted there in his words: *"We already take
  detailed consent from every patient. This is a non issue. Do it for all speakers."* The Builder has
  not seen the consent, its wording, or its scope, and has not verified that it covers this
  processing.
- **Status.** Recorded as ruled. It stays unverified by the Builder.

---

## Security fix, 13 Sep 2026 — the batch endpoint was an open SSRF (FIXED, recorded here)

The first `/inference/wavlm/segments` fetched any https URL on any `*.r2.cloudflarestorage.com` host with
no authentication: anyone reaching the public hostname could pull 200 MB through the Mini, run ffmpeg on
it, and hold a serialised service. Fixed: shared secret required before any fetch, exact host match on
our bucket host, https/443/no credentials, no redirects, byte/timeout/wall-clock/duration caps — each a
named refusal. Proven live through the tunnel (foreign host, `ours.evil.com`, `evil-ours`, another bucket
in the same R2 account, http, credentials in URL, missing secret, wrong secret — all refused; our real
presigned URL scored) and offline against the same code for the two cases that cannot be produced live
(a redirect: our bucket does not redirect; an oversized body: no object that large exists).
See the build report's endpoint section.

**MANUAL STEP FOR V:** set `EMOTION_SEGMENTS_SECRET` in the app's Vercel environment to the value in
`~/.config/eta-emotion/segments-secret` on the Mini (e.g. `pbcopy < ~/.config/eta-emotion/segments-secret`).
Until then any emotion job fails `emotion_not_configured`, and the enqueue refuses loudly once
`EMOTION_ENABLED` is on. Nothing runs today either way: both flags are unset.

## Open item 6 — the pre-existing emotion endpoints are unauthenticated (for V to rule)

Unchanged today, by order. On `https://emotion.llmvinayminihome.uk`, with no authentication:
- **`POST /inference`, `/inference/wavlm`, `/inference/emotion2vec`** — accept a multipart upload of ANY
  file. The whole upload is read into memory (no size limit), written to a temp file and run through
  ffmpeg (timeout 300 s) — ffmpeg's full demuxer/decoder surface on attacker-chosen bytes. They return
  seven affect scores for the audio. `model=emotion2vec` (or `/inference/emotion2vec`) LAZY-LOADS the
  second model (`emotion2vec_plus_large`, FunASR) into the Mini's shared RAM — it was found loaded before
  the first restart today, and unloading it freed ~1 GB. Every inference holds the service-wide lock
  (open item 3), so one caller can stall all others. The ffprobe-failure truncation (open item 2) is
  reachable here.
- **`GET /health`, `/healthz`** — model id, device, loaded state, load mode, `max_duration_s`, process
  RSS, available RAM on the Mini, labels, and each model's last error as a Python `repr` (which can
  include file paths).
- **`GET /docs`, `/redoc`, `/openapi.json`** — FastAPI's generated documentation of every endpoint,
  including the new one's path (its secret is not in the schema). All three answered 200 publicly.

## P2 — recorded, not fixed

- **A 400-digit integer segment bound returns HTTP 500.** `/inference/wavlm/segments` converts bounds
  with `float()`; `float(int("9"*400))` raises `OverflowError: int too large to convert to float`, which
  is not caught. The request is already authenticated and host-checked by then; nothing is fetched.
  Confirmed offline.
- **Cloudflare replaces the Mini's 502 JSON.** When the service answers 502 (a refused fetch), the tunnel
  substitutes its own error page, so the app's parse finds no `error` field and records the reason as
  `unknown`. The job still fails and records a failed window; the specific refusal code is lost.
- **The 50 ms tail is cut silently.** A segment ending up to 0.05 s past the decoded audio
  (`SEGMENT_END_SLACK_S`) is scored on the audio that exists and not refused. The row's `duration_s`
  shows the shortfall; nothing else does.

## Swift — the `swift test` exit 1 (resolved, with one intermittent test)

`swift test` failed to compile on the Mini: `external macro implementation type
'TestingMacros.TestDeclarationMacro' could not be found … plugin for module 'TestingMacros' not
found`. The plugin exists at
`/Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing/libTestingMacros.dylib`, but the
compiler does not search that `testing/` subdirectory in this Command Line Tools install (27.0, installed
10 Sep; no Xcode.app on the Mini). No test code changed. With the path passed explicitly —
`swift test -Xswiftc -plugin-path -Xswiftc /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing`
— run 1: 599 of 600 passed; `RetainedArchiveRecoveryTests.rolloverCommitCrashPointsConvergeWithoutPrePlanAudioVisibility`
recorded `keywrapMismatch`. That suite then passed 10/10 twice in isolation, and a full re-run passed
**600/600**. The failure is intermittent, not reproduced; it is recorded as a flaky test, not proven
fixed. The session is over SSH with the login keychain reported unlocked (no-timeout).

## Mini services — version control (13 Sep 2026)

Local history only: no remote on any, nothing pushed, nothing vendored into this repo, no service
restarted. Committed files were staged by name and re-scanned from the index before committing;
logs, virtualenvs, models and audio are ignored.

**Now versioned (initial commit):**
| service | directory | files committed |
|---|---|---|
| eta-indic (:8082) | `~/eta-indic` | `indic_server.py`, its `.bak`, `install-indic-launchd.sh`, `.gitignore` |
| eta-stt-relay (:8787) | `~/eta-stt-relay` | `stt-relay.mjs`, `package.json`, `package-lock.json`, `.gitignore` |
| whisper shim (:8081) | `~/.local/bin` | `whisper-shim.py`, `.gitignore` (allow-list: the directory holds other tools, which are not tracked) |

`stt-relay.mjs` tripped the scanner once on `const SECRET = process.env.STT_RELAY_SECRET` — confirmed an
environment read with no literal, and the only match, before committing.

**Already versioned:** `~/whisper.cpp` (:8080) — a clone of upstream at `v1.8.5`; no local source
changes (only untracked log files).

**BLOCKED — not committed, because the directory contains tunnel hostnames.** No token, key or
password VALUE was found in any of them (secrets are read from the environment or from files outside
these directories); what blocks them is the tunnel hosts, as ruled.
| service | directory | files carrying tunnel hosts |
|---|---|---|
| eta-emotion (:8086) — holds the new C3 endpoint | `~/eta-emotion` | `README.md`, `STATUS.md`, `cloudflared-snippet.yml`, `install-emotion-launchd.sh`, `install-emotion-launchd.sh.bak` |
| eta-diarize (:8001) | `~/eta-diarize` | `SETUP-LOG.md` |
| eta-router (:8083) | `~/eta-router` | `RESEARCH-ROUTER-RELAY-EMOTION-11-SEP-2026.md` |
| eta-sravaani (:8085) | `~/eta-sravaani` | `cloudflared-snippet.yml` |
| eta-status (:8084) | `~/eta-status` | `status_server.py` (the service itself) |
| minidisk (:8765) | `~/.local/minidisk` | `cloudflared-config.yml`, `config.yml.live`, `tunnel-route.sh`, `install-disk-route.sh`, `reload.sh`, `minidisk.log`, and others; also tunnel credential-file paths and an auth-token file path |
| even-scribe-session-id (worker) | `~/dev/even-scribe-session-id` | `session_id.py`, `README.md` |
| even-scribe-stt-drain (worker, 48 GB directory) | `~/dev/even-scribe-stt-drain` | `stt_drain.py`, `README.md` |

For all of these except minidisk, the hostnames are in docs or scripts rather than secrets proper, and
the same hostnames already appear in this public repo (e.g. `lib/stt/adapters/route.ts`,
`lib/emotion/client.ts`). Two ways to unblock, for V to rule: treat the tunnel hostnames as not secret,
or commit each directory with the files above git-ignored (for `eta-emotion` that keeps `app.py` —
the endpoint — and its `.bak` files under history).

**Running but not ETA/Scribe services, not touched:** openclaw gateway (:18789), surgvlp-lab (:8087),
Work Database (:8000), ollama (:11434), and the `gs-tc-*` cohort batch agents.
