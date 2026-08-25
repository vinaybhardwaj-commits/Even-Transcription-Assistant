# ETA Room Recorder — PRD v1.1

**25 August 2026 · Ratified by V · Status: FINAL, nothing open**

v1.1 adds the Brain: decisions R19 to R22, the brain feed component, and Phase 4. v1.0 had no
brain section. That was a gap V caught, not a decision.

This document specifies the native Mac application that replaces the browser room kiosk. It
carries every decision. Inputs, both binding: the designer recommendation
(`DESIGNER-REC-ROOM-RECORDER-APP-25-AUG-2026.md`) and the repo audit of 25 August (wire
protocol, format assumptions, launchd patterns). It supersedes Part Two of
`ETA-DESIGNER-STATE-OF-PLAY-AND-NATIVE-KIOSK-PROPOSAL-25-AUG-2026.md`, which recommended a
wrapper. Do not build a wrapper.

---

## 1. Why

Every operational failure in the pilot was a browser failure. A tab anyone can close. A page
that dies with sleep. A deploy that needs a walk to every room. Nothing after a restart. On
24 August three rooms became unreachable at once and the only fix was to walk to them.

The app removes the category. It launches at login before anyone arrives, restarts itself if
it dies, comes back after a power cut, cannot be closed by a passer-by, holds the machine
awake while recording, reports itself whether or not anyone is recording, and can be
restarted remotely as a process.

---

## 2. What does not change

The server. The API. The audio contract. The operator page. The brain. The STT path.

The app speaks the exact wire protocol the browser speaks today, verified against the repo
on 25 August:

1. `POST /room/{slug}/api/login` with the 4-digit PIN → 30-day room token.
2. `POST /api/bench/sessions` to open a session. `PATCH .../{id}` to pause, resume, end.
3. `POST /api/bench/upload-url` → presigned PUT, then `PUT`, then `HEAD` to check the byte
   count.
4. `POST /api/bench/chunks` with idx, content type, started_at, ended_at, duration_ms,
   size_bytes, gap_before_ms, peak_level, avg_level, and `source:"backup"` only on the spare
   lane. The server re-checks the byte count and marks the piece verified.
5. `POST /api/bench/events` for the five locked microphone event kinds.
6. `GET /api/bench/commands` with tab_id, prev_poll_at, the level fields, and paused state.
   `POST .../{id}/ack` for each command. Cadences unchanged: 1.5 s recording, 3 s idle,
   5 s hidden. Last poll wins.
7. `POST /api/bench/brain-proxy` for the whitelisted brain events: `consult_mark` (the Mark
   verb, room + timestamp only, no patient id) and `live_sink_stats`. Durable-first into
   `bench_event`, exactly as the browser does today.

Pieces are five minutes of webm/opus, mono. Same content type string. Same R2 keys. The
existing `gap_before_ms` field is how a gap is told to the server. No new format, no new
field, no new endpoint in version 1.

---

## 3. Decisions

All ratified by V on 25 August. Do not reopen any. R12 restates D39 of the monitoring PRD,
which also stands.

| # | Decision |
|---|---|
| **R1** | **Native app, no browser engine anywhere.** Not Electron, not Tauri, not WKWebView. Swift. The process owns the microphone. |
| **R2** | **The server contract is untouched.** The app produces the same webm/opus pieces through a bundled encoder. If native capture cannot emit a piece the server already accepts, the capture is wrong. |
| **R3** | **The engine is durable-PCM-first.** The capture callback appends raw PCM (16 kHz, mono, 16-bit) to an append-only per-lane day file and does nothing else. Full fsync every ~2 seconds. A cutter derives each five-minute piece from durable PCM at sample-exact offsets. A short-lived encoder child turns the piece into webm/opus. A stateless sweeper uploads and verifies. A crash in any stage after the day file costs nothing. The worst any crash or power cut can cost is ~2 seconds of tape. |
| **R4** | **The sample count is the clock.** Piece boundaries are sample arithmetic from a capture epoch. The seam between two pieces is one shared integer: ended_at of piece N equals started_at of piece N+1, gap 0 by construction. Wall-clock stamps derive from fsynced anchor records (sample position, monotonic time, wall time) with a fitted drift estimate. A clock jump opens a new anchor segment, applied only at a piece boundary, never smoothed in. After a hard crash, the app re-derives stamps by arithmetic. A stale anchor makes the recovered piece **explicitly uncertain** in the local manifest, never confidently wrong. |
| **R5** | **Health is the tape advancing.** The app reports healthy only while the durable sample index grows. Process liveness is never a health signal and never an alarm. Levels (RMS 0..1, same units as today) come from the same native tap that feeds the tape. |
| **R6** | **Lanes are independent, and a spare exists only when a second device exists.** Device selection by stable device id, never by enumeration index. One microphone is a normal room (D32). No backup lane, no backup pieces, no spare vital without a chosen second device. A spare lane failure never touches the main lane. This absorbs the client half of backlog P8. |
| **R7** | **Signing: our own certificate.** Generated once, trusted once per machine at install. Ad-hoc signing is rejected because its identity changes every build and the microphone permission would not survive an update. The bundled ffmpeg is vendored inside the app and signed with the same certificate, so a Homebrew upgrade can never touch the encoder or its permission. |
| **R8** | **Auth: the same PIN login.** The app performs the existing PIN login and holds the 30-day room token in the Mac keychain. No new server auth path. |
| **R9** | **Self-update in version 1.** The app checks a server-announced version, downloads the signed bundle from R2, verifies the checksum, swaps, keeps the previous version for rollback, and lets launchd relaunch it. Because the signing identity is stable (R7), the microphone permission survives every update. An update never runs while a session is recording. |
| **R10** | **Supervision: a launchd LaunchAgent with RunAtLoad and KeepAlive**, the same pattern as the four Mini services. Full-screen. Quit requires the room PIN. The app holds a power assertion while recording. |
| **R11** | **The room screen is the designer's: a lamp, not a dashboard.** States off / recording / paused / finished for today. Three verbs: Start, Pause, Mark consult. Pause is consent; its copy is counsel's. The setup overlay (first launch or long-press): microphone name, a level meter, and whether a spare **device** is present. Nothing else on the consult face — no counts, no timers as hero, no operator telemetry. |
| **R12** | **D39 stands: no key stroke and no mark ever gates processability.** The day record opens when tape starts (server-side, Build 3). Marks are consult boundaries only. The destination for boundaries is voice identification, not taps. |
| **R13** | **The local tape is the system of record.** Raw PCM and its index are kept **14 days after verified upload**, encrypted at rest with a key held in the Mac's secure hardware. Uploaded pieces are a cache. Any server-side doubt — a missing piece, a suspect stamp, a wrong binding — is repairable from the room by re-cutting from the tape. |
| **R14** | **Gaps are recorded facts.** Device loss produces a measured gap carried in `gap_before_ms` and a discontinuity record in the index. Nothing is ever zero-filled into the raw tape. The archive holds only what was heard. |
| **R15** | **Phase 0 gates everything.** A ~200-line tapewriter harness runs a full day on the real Mini with the real microphone, killed hard mid-hour, with one power pull. A verifier prints per-anchor drift. No engine code beyond the harness is written until its report is read. |
| **R16** | **Clinic rooms hold for the app.** No browser rebuild. Home Office is the test bed. Clinic rooms come back when the app installs. |
| **R17** | **Remote control:** restart of the app process is in scope. Remote start/stop/pause of the tape stays listener-gated and consent-aware, exactly as today. Remote Mark stays fallback only. |
| **R18** | **The alarm rule applies to the app** as to everything else: test any new alarm against an ordinary day before it ships. Candidate for later, not version 1: cross-lane divergence as an alarm. It must first prove itself silent on ordinary days, and it can never apply to a one-microphone room. |
| **R19** | **The app is the brain's senses and face, never its memory.** The live voice loop, ratified 25 August: the app contributes what only the room can — sample-exact audio segments, levels, voice activity, marks, consent state. The voice service (pyannote, on the backend Mini) turns segments into signatures. The **database** does the centroid matching and ranking, per D25. The **server brain** runs the consult state machine and pushes state back over the existing command bus, so the lamp reflects it within seconds. No torch runtime ever ships on a clinic Mac. |
| **R20** | **The brain-facing surface ships in version 1**, before any voice slice exists: Mark via brain-proxy, cue and event posting, pause as both a true capture gap and a brain signal, `live_sink_stats` at its existing cadence, and a per-second level/voice-activity sidecar written beside the tape (promoted from roadmap — it is the brain feed's substrate and the silent-window tag for STT). Sample-indexed first, wall time derived, one clock with the tape. |
| **R21** | **Phase 4 is the live consult-state loop**, gated on the §15 voice pre-flight, which runs during Phases 0–1 on the 24 August tape (Cardiology and OPD 5 — diarization has never yet run on room audio). The state machine covers: consult started, paused, stopped, **patient left for investigations, patient returned, doctor resumed and completed**. Its detailed design gets its own decision round with a divergent pass before the Phase 4 kickoff — it is the hardest open design in the programme and is not settled by this PRD. Phase 4 adds one new server surface for short-segment intake (the five-minute piece is too slow a feed for a live lamp); that change belongs to Phase 4, so version 1's "no new endpoint" holds. |
| **R22** | **Until Phase 4 lands, the lamp shows recording state. After Phase 4, the lamp shows brain state.** The app never decides consult state itself in either era — it displays what the brain tells it and what the tape is doing. Voice-identified marks then replace taps as the ordinary source of consult boundaries (D39's destination). |

---

## 4. The engine, in plain words

One process, several stages, one direction of trust: the tape first, everything else derived.

- **Capture core.** One AVAudioEngine input tap per lane at 16 kHz mono. The callback appends
  to the day file. No locks, no allocation, no network on that thread.
- **Day file + index.** `tape/<date>/<lane>.pcm` append-only, with `<lane>.idx` holding one
  record per fsync: byte offset, samples written, monotonic time, wall time, device id, RMS.
  On boot the app trims the file to sample alignment, writes a discontinuity record, and
  resumes. A piece never spans a discontinuity: the current piece closes short and the next
  starts clean.
- **Cutter.** Wakes every ~10 s. When a full five-minute sample range is durable, it hands
  the range to the encoder child and writes a manifest: room, lane, day, idx, sample range,
  derived stamps, levels.
- **Encoder child.** Vendored ffmpeg reads raw PCM, writes webm/opus. If it crashes, the PCM
  is still on disk; the cutter retries. The encoder never touches a file the capture core has
  open for writing.
- **Sweeper.** Stateless scan of the spool: presign, PUT, HEAD, chunk row, move to done.
  Retry from disk, oldest first, backoff 5 s to 60 s, infinite. Duplicate-safe on
  (session, lane, idx), the same idempotence the server already provides.
- **Poller.** The existing command channel, unchanged, with `tab_id` of the form
  `app_<machine>`. Heartbeat and level fields exactly as Build 2 defined them.
- **Updater.** R9. Never during a recording session.
- **Brain feed.** R20. Posts marks, cues and `live_sink_stats` through brain-proxy, and
  writes the per-second level/voice-activity sidecar (`<lane>.lvl`, ~4 bytes per second)
  from the same samples that feed the tape. In Phase 4 it also ships short sample-indexed
  segments to the voice service. It reads the tape; it never sits on the capture thread.
- **Screen.** R11. The UI process work never runs on the capture thread; if the UI hangs, the
  tape does not.

Machine provisioning (part of the install runbook, one page): auto-login, never sleep,
Gatekeeper trust of our certificate, microphone approval — one click, once per machine,
surviving all updates.

---

## 5. What the app absorbs, and what Build 3 keeps

**Absorbed into the app** (client work that would be throwaway in the browser):
- The client half of P8: spare-exists from device presence (R6).
- Build 2's client behaviors, as spec: idle heartbeat, level accumulators and units, the
  mic-health clearing rule, resume seeding, remount and takeover semantics. The four pure
  spec files in the repo (`bench-dual`, `mic-health`, `bench-bus-constants`,
  `bench-resume-core`, ~1,400 lines, no browser imports) are the reference implementation
  the Swift port is checked against.

**Build 3, trimmed, all server-side, unchanged in intent:** run-waiting-audio (2.1), the
sixteen re-binds (2.2), day auto-open D39 (2.3), the server half of P8 — no spare lane
rendered, no spare alarm (2.4), door reports levels (2.5), backlog honesty (2.6). Build 3
goes to Claude Code first, then the app build starts.

---

## 6. Build order and acceptance

**Phase 0 — the harness (gates all).** Tapewriter on the real Mini, real microphone, full
day. Kill -9 mid-hour. One power pull. Verifier reports: worst tape loss (must be ≤ ~2 s per
event), per-anchor drift, discontinuity records present and honest.

**Phase 1 — headless engine on Home Office.** Capture core, day file, cutter, encoder,
sweeper, poller. Acceptance: a full Home Office day through the app; every piece verified by
the **current production server**; seam 0 between consecutive pieces; day record present with
zero marks (D39, requires Build 3 shipped); kill -9 during recording costs ≤ 2 s and the day
continues; one microphone yields no backup pieces and no spare vital anywhere.

**Phase 2 — the room screen.** Lamp, three verbs, setup overlay, PIN gate on quit, consent
pause with counsel's copy. Acceptance: designer reviews screenshots against R11; a passer-by
cannot close it; Pause creates a true capture gap.

**Phase 3 — update and rollout.** Self-update proven twice on Home Office (one normal, one
rolled back), microphone permission surviving both. Install runbook written. Then clinic
rooms, one at a time, Cardiology first.

**In parallel with Phases 0–1 — the §15 voice pre-flight.** The four questions of the
monitoring PRD's §15, answered from the 24 August tape (Cardiology and OPD 5) through the
existing diarize service. No app code involved. Its report gates Phase 4 and nothing else.

**Phase 4 — the live consult-state loop (R19, R21).** Specced in its own decision round
after the pre-flight report is read; built only after V ratifies that spec. Acceptance shape,
binding now: a real clinic day where consults are opened, paused, and closed by identified
voices; a patient leaving for investigations and returning is tracked as one consultation;
the lamp reflects each state change within seconds; and a tap on Mark is the exception, not
the plan.

**Report back** (designer's asks, kept verbatim): what was built, how it is signed and
installed; one Home Office day through the app with pieces verified and a day record present
without a mark; any place native capture could not match today's piece contract, named.

---

## 7. External dependencies and roadmap

**External:** counsel's consent copy for Pause (only outstanding input to Phase 2).
**Owed elsewhere, unchanged by this PRD:** credential rotations, `claude@even.in` rotation,
test clinician deletion, the stale `ended_disagrees` row.

**Roadmap, explicitly not version 1:** a local range-read door on the room Mac (any time
window of the day, served from the tape); mark-aligned retroactive cuts (the landing zone
for voice-identified marks, R22); anchor log uploaded server-side so stamp repairs become
recomputation; nightly tape-vs-server reconciliation. Each needs its own decision round;
none blocks version 1. The per-second level sidecar moved into version 1 (R20).
