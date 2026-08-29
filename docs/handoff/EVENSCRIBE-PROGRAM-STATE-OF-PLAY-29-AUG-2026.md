# EvenScribe programme — state of play

**29 August 2026 · For the architecture team · From V (Hospital Product, EHRC)**

**Code:** https://github.com/vinaybhardwaj-commits/Even-Transcription-Assistant · native app on
branch [`feat/room-recorder`](https://github.com/vinaybhardwaj-commits/Even-Transcription-Assistant/tree/feat/room-recorder)
**Production:** https://www.evenscribe.app · pinned deployment `dpl_497Ns1qzVnTvZ7N7YgTt61UgMUX2` · database migrations through `0070`

---

## 1. What EvenScribe is

EvenScribe records the clinical conversation in OPD rooms, keeps that audio safe, and turns it
into transcripts and, eventually, structured visit notes. The unit of capture is the **room**,
not the doctor or the appointment: a room records its whole day, the archive is the source of
truth, and everything else — transcripts, visits, statistics — is derived from it and can be
re-derived. Two rules govern every change: **the archive always wins** (no change ships if it
could cost one piece of clinical audio), and **no key stroke or mark ever stands between
recorded tape and processable tape** (decision D39, proven live in production).

## 2. The system today

**Server.** A Next.js application on Vercel (`evenscribe.app`), Postgres on Neon, audio pieces
in Cloudflare R2. Rooms authenticate with a PIN and a 30-day token. The wire contract is six
plain HTTPS calls: presigned upload, byte-count verification, chunk registration, events,
command polling with acknowledgements, and a brain proxy for consult marks. An operator
monitoring page and an operator MCP door read one shared source of room facts. Audio joining
runs in a Cloudflare container (ffmpeg). The **brain** — consult inference — lives server-side
by decision R19: the room contributes senses; the server holds memory and judgement.

**Mac Mini backend.** Four launchd-supervised services behind a Cloudflare tunnel: Whisper
(whisper.cpp + a transcoding shim), a Sarvam streaming relay, pyannote
diarization/enrolment, and a local LLM. This machine also hosts the native app's physical test
evidence.

**Rooms.** The legacy browser kiosk survives only in the Home Office; all four clinic rooms are
offline and **held for the native app** by a ratified decision — no browser rebuild. The browser
kiosk's operational failures (closable tab, dies on sleep, deploy requires a walk, nothing
survives a restart) are the reason the native app exists.

**The Room Recorder (native app).** A dependency-free Swift application replacing the browser
kiosk on the room Macs. Architecture, all ratified: native CoreAudio capture → **encrypted,
authenticated local day-tape and index** (AES-256-GCM, per-day/per-lane keys wrapped by the
Mac's Secure Enclave) → sample-exact five-minute cutter with a fsynced reservation journal →
bundled minimal ffmpeg/libopus producing the exact WebM/Opus piece the server already accepts →
disk-backed upload sweeper → the unchanged production APIs. The sample count is the clock; wall
time is derived; gaps are recorded facts, never zero-filled. Health is defined as **durable
tape growth** — never process liveness, device presence, or level activity.

## 3. Where the Room Recorder actually stands

**Proven, on real hardware and real production:**

- Phase 0 physical protocols all passed on the Home Office Mini with the production microphone:
  hard kill (1.11 s worst tape loss), wall-power pull (1.30 s), microphone yank (honest
  device-lost/resumed facts, no fabricated audio), and an 8-hour loaded run with zero dropped
  blocks at under 0.5% CPU.
- The unsigned development build runs **today** as a LaunchAgent on the Home Office Mini:
  auto-starts at login (proven through a real logout/login), records on a remote command,
  uploads pieces the production server verifies (full five-minute piece, gap 0), opens the
  room-day with zero marks, survives kill and network outage with exact single re-registration,
  and correctly reports a session that produced no durable tape as **failed** rather than
  healthy.
- Server side: Build 3 closed — recovery controls, the sixteen wrongly-bound Cardiology windows
  re-bound to the main microphone, D39 auto-open live, phantom-spare class eliminated
  (`spare_exists` now means a device exists; the long-mysterious "68-to-1 broken spare" was no
  spare at all).

**Honest distance to done** (the team's own assessment: *"substantial foundations, incomplete
product integration, not production-ready"* — 40–50% of Build B implemented, 5–8 weeks to Build
B acceptance, 10–16 weeks provisional to clinic-ready):

- No signing identity exists. Until it does (step B4), every new binary costs a per-machine
  Gatekeeper approval and a microphone permission click.
- No room screen (Build C: a lamp and three verbs — Start, Pause/consent, Mark) and no
  self-update (Build D).
- No power assertion in the app yet; the Minis' never-sleep setting carries that.
- Microphone events and the idle-heartbeat cadence ladder are not yet sent; archive retention
  and deletion are deliberately disabled until coverage can be proven.
- The destructive acceptance matrix, a signed production smoke, and the 12-hour single-day
  acceptance run have not started. Loss budget for acceptance: at most 2.000 seconds under any
  crash.

**Remaining Build order (ratified):** B1–B2 finish the resident engine and local pipeline; B3
security and headless control plane; B4 signed product identity; B5 freeze; B6 physical and
production acceptance; B7 report. Then Build C (screen), Build D (update/rollout), then rooms.

## 4. Transcription — the current weak layer, and the next focus

Capture is ahead of comprehension. Two clinic days (over 8h44m of verified tape) plus ongoing
Home Office tape exist; transcription remains **manual and paid by explicit operator action**
(a deliberate cost decision, D28). What exists: nine configured engines (Deepgram, Whisper on
the Mini, Sarvam, ElevenLabs ×2, IndicConformer ×2, an internal pipeline, EkaScribe disabled),
an engine-fanout lab with routing, a run-waiting-audio operator control with per-window
reporting, and window-level accounting of what is stranded and why.

Known problems, all measured, none fixed:

1. **Whisper will not admit silence** — roughly 1 in 8 quiet windows returns empty; the rest
   hallucinate filler. A per-second level/voice-activity sidecar exists in the app design
   precisely to tag silent windows before they reach an engine.
2. **Costs are not reported per call** — Sarvam's adapter returns no cost value, so the paid
   control shows "no cost reported."
3. **Code-mixed OPD speech** (Kannada/Hindi/English in one consultation) has no per-segment
   language measurement yet; engine choice per window is therefore unprincipled.
4. **No room gold set** exists to score engines against; Whisper's non-determinism is unmeasured.
5. Twelve re-bound Cardiology windows await V's continuation before their paid runs.

Fixing this layer — engine quality, routing, honesty about silence, cost, and language — is the
programme's next work stream.

## 5. The voice path (designed, gated, unbuilt)

Ratified destination: consult boundaries come from **voice identification, not taps**. The
design is settled — voices enrolled from real room recordings, a patient holds a *set* of
voices, roles inferred from recurrence across unrelated patients, the database does the
matching and ranking — and the live loop is Phase 4: the app streams sample-indexed segments,
the voice service makes signatures, the server brain runs the consult state machine (started,
paused, patient left for investigations, returned, completed) and lights the room lamp over the
existing command bus. Phase 4 is gated on a voice pre-flight (four questions answered from the
24 August tape) that has not yet run; diarization has never once run on room audio.

## 6. Risks and owed items the architecture team should see

- **No key escrow** for the encrypted archive: device-bound Secure Enclave wrapping means loss
  of the Mac can make retained local tape unrecoverable. This specific choice currently carries
  builder authority, not a V ratification; it must be consciously ratified before
  encrypted-archive acceptance. (Uploaded pieces on R2 are unaffected.)
- **Signing identity** is the single hardest unowned dependency (B4).
- The PRD's fsync-cadence wording (~2 s) trails the validated 1.25 s and designed 1.0 s figures;
  a text reconciliation is owed so three numbers stop coexisting.
- Credential rotations owed: the operator token, two database roles, one Google account.
- The four clinic rooms stay dark until the app ships — accepted, but it is real recording
  downtime.
- Carried debt, named in the repo: nine pre-existing silent error handlers; encoder tests are
  opt-in; local archive grows unbounded until retention proof lands.

## 7. Where everything is written

In `docs/handoff/` on the branch: the Room Recorder PRD v1.1 (decisions R1–R22), the ratified
Build B decision packet (V1–V10), the builder design-provenance record (crypto and format
specifics), the revised build plan (B0–B7), the 28 August engineering state-of-play with its
29 August handover update, the Phase 0 execution handoff with full physical evidence, and the
Build 3 corrective report. The monitoring-surface PRD (decisions D1–D39) governs the operator
page. Raw audio evidence lives on the Home Office Mini, outside Git, by design.
