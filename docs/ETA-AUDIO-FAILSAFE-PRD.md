# ETA — Audio Capture Failsafe PRD (Never Lose a Consult's Audio)

**Status:** OPEN · **Created:** 2 Jun 2026 · **Owner:** V (Dr. Vinay Bhardwaj) · **Repo HEAD at writing:** `d134ef0`

## 1. Why this exists (postmortem context)

On 2 Jun 2026 Dr. Ankit Bhojani lost the audio of two live Kannada consults. Submit failed with `no_audio_chunks`, **yet the live transcript displayed the whole consult**. Root cause (B18 in `ETA-BUG-LOG.md`): on iOS/WebKit, MediaRecorder and the Sarvam **streaming** WebAudio worklet both consumed the same mic track; the worklet won (transcript showed) and starved MediaRecorder (0 chunks → empty IndexedDB → nothing to upload). The hotfix (`d134ef0`) disables the streaming worklet on iOS and falls back to the chunk-based rolling path.

Two systemic weaknesses the incident exposed — independent of that specific bug:

1. **Capture can fail silently.** The clinician sees a healthy live transcript and a running timer while *zero* audio is being persisted. The only safety net (`no_audio_chunks`) fires at Submit — after the consult is over and unrecoverable.
2. **Two independent captures.** The audio that drives the live transcript and the audio we persist for the note are captured separately, so one can die while the other looks fine. A working transcript does **not** imply recoverable audio.

**Guiding principles for this work:**
- **Never fail silently** — detect a dead capture *during* recording or *before* it starts, not at Submit.
- **Save what we transcribe** — the bytes we persist should come from the same known-good capture that produces the transcript, so "transcript works" ⇒ "audio saved."
- **Defense in depth** — client detection + a robust client capture + a server-side copy + fleet monitoring, so no single failure loses a consult.

## 2. Scope (chosen 2 Jun)

In scope: **#2 Preflight capture self-test**, **#3 Save-what-you-transcribe (unified capture)**, **#4 Server-side relay capture + no-audio alerting**.
Deferred (V deprioritized): **#1 real-time on-screen "audio not saving" alarm** — cheap client-only insurance; can be added later or folded into #2's machinery. We already track `chunksCount`/`bytesEmitted` live in `RecordingScreen`, so it's a small add if wanted.

## 3. Designs

### #2 — Preflight capture self-test (client-only)
Today `PreflightCheck` only probes `/api/health` and explicitly (and wrongly) assumes "audio chunks always land in IndexedDB." Replace that assumption with a real test.

- After the health check + user gesture, run a **1–1.5s capture self-test**: `getUserMedia(audio)` → `new MediaRecorder(pickMime())` → `start(250)` → require **≥1 chunk with `size > 0`** → `stop()` + **fully release tracks**.
- **Pass** → allow recording. **Fail** (0 chunks / size 0 / exception) → block with clear guidance ("Audio capture isn't working on this device — fully close & reopen the page, or use a laptop/Android; don't start the consult until this passes") + Retry.
- **iOS care:** must fully `stop()` all test tracks (and a short delay) before the real `getUserMedia`, so the self-test doesn't hold the mic. **Needs device testing.**
- Fix the misleading comment in `PreflightCheck.tsx`.

### #3 — Save-what-you-transcribe / unified capture (the durable fix)
Eliminate the "two independent captures" flaw so capture-success and transcript-success share fate.

- **Approach A (recommended): record the AudioContext graph, not the raw track.** One `AudioContext`: `MediaStreamSource(mic)` → (a) the live PCM worklet (transcript) **and** (b) a `MediaStreamDestination`; `MediaRecorder` records the **destination** stream. Both consumers hang off one graph rather than contending for the raw `getUserMedia` track, so iOS feeds it once and MediaRecorder always gets data. Keeps webm/opus compression.
- **Approach B (alternative): persist the worklet PCM.** Tee the worklet frames to IndexedDB and encode WAV at submit. Pro: literally the transcribed bytes. Con: ~1.9 MB/min (16 kHz mono 16-bit), and the worklet currently only runs for streaming so it'd have to run always.
- **Recommendation: Approach A.** It unifies capture for *all* engines (English + non-English) and keeps the current rolling/iOS fix as the safety net until A is device-proven.
- **Risk:** core rewrite of the capture path → its own sprint, behind real iOS + Android device testing. Do **not** ship without device confirmation; keep `d134ef0` behavior as fallback.

### #4 — Server-side relay capture + no-audio alerting
Two parts:

- **4a — No-audio telemetry/alert (server + admin; buildable & verifiable now).** Flag encounters that are `draft`/`recording` with no `audio_object_key` older than N minutes; surface on the admin Health / Launch-Readiness view, and optionally a client beacon when `bytesEmitted` stays 0 mid-recording. Goal: catch device-class regressions across the fleet instead of waiting for a WhatsApp message.
- **4b — Relay persists streamed audio (Mac Mini change; V applies).** The Sarvam STT relay (`wss://stt.llmvinayminihome.uk`, on the Mini) already *receives* the PCM that produces the live transcript. Have it buffer per-session PCM and, on close, encode + upload to R2 keyed by `encounter_id` (the encounter id is passed via the WS token/query). Then `finalize-upload` can adopt the relay's copy when the client audio is missing. Result: for the streaming path, even a total client-capture failure still leaves a recoverable recording. (Deepgram/English is 3rd-party cloud — no raw-audio return — but that path is the robust single-consumer path anyway.) **Runbook to follow; never `pip`/`brew upgrade` the relay venv.**

## 4. Proposed sequencing (safety-first)

- **Sprint 0 (now, no code):** this PRD + **confirm the `d134ef0` iOS fix on Dr. Ankit's iPhone** (a real Kannada consult submits successfully). Gates everything that touches the recording path.
- **Sprint 1 (safe, verifiable now):** #2 preflight self-test + #4a no-audio telemetry/alert. Client + server/admin only; no capture-architecture change.
- **Sprint 2 (device-gated):** #3 unified AudioContext capture. Build behind device testing; keep iOS-rolling fallback.
- **Sprint 3 (Mini runbook + app):** #4b relay-side audio persistence + finalize-upload adoption.

## 5. Verification & rollback
- Every sprint: build green → deploy → verify live `sha` → **device test on a real iPhone + Android** (the sandbox cannot drive iOS WebKit) → tag. A failed build never deploys.
- #3 must be reversible to `d134ef0` behavior via a flag until proven on devices.
- Note quality is unaffected by all of this (the note is built from submitted audio, not the live transcript).

## 6. Open questions for V
1. **Sprint 1 go?** Start with #2 + #4a now (lowest risk, immediate value)?
2. **#3 Approach A vs B** — confirm A (record AudioContext destination) is acceptable.
3. **#4b Mini relay** — OK to modify the relay to persist audio to R2? You'll apply the Mini change; I write app-side + runbook. Retention = same policy as encounter audio.
4. **#1 alarm** — want the cheap real-time "audio not saving" banner folded into Sprint 1 as well?
