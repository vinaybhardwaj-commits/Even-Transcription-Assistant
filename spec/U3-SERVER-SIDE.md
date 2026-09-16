# U3 — Server side: enrol, poll, pieces, command bus

Status: SPEC. Not built. Base: 720572e.
Grounding: every Mac citation below is `apps/room-recorder/<file>:<line>` in
Even-Transcription-Assistant on the Mini, read 16 Sep 2026.

---

## 1. Decisions log — ratified by V, 16 Sep 2026

D1. **Spool is capped.** The Mac spools without bound (`PiecePipeline.swift:574-660`);
    an offline room fills its disk and the recorder dies, losing capture. Linux caps the
    spool. When full, the oldest spooled pieces are dropped and the drop is logged.
    `tape.pcm` is never touched, so any dropped piece is re-cuttable from the tape.
    Capture never stops for a full spool. Cap value: `our-choice`, see S4 below.

D2. **Transcode stays on the room machine, byte-compatible with the Mac.**
    ffmpeg becomes a U4 apt dependency. The argv is copied exactly
    (`PiecePipeline.swift:478-499`):
    `-hide_banner -loglevel error -nostdin -n -f s16le -ar 16000 -ac 1 -i <pcm>`
    `-map_metadata -1 -c:a libopus -application voip -b:a 32k -vbr on -frame_duration 20 -f webm <out>`
    Mac resolves ffmpeg from `Contents/Helpers/ffmpeg` with no PATH fallback
    (`InstallPollFields.swift:359-372`); Linux resolves an absolute pinned path, never PATH.
    NOTE: encoded container bytes are NEVER compared against the Mac. Only the decoded
    PCM is comparable. This is a standing project rule.

D3. **Self-update is not ported.** `RoomSelfUpdate.swift` (1382 lines) is out of scope.
    `check_update_now` is accepted and acked `ok:false,"unsupported_kind"` so the Bench
    does not error. Updates ship by re-running the U4 install script.

D4. **Full command bus in the first cut.** All eight kinds, not a subset.

D5. **The Bench is admin-only.** Doctors have no Bench interface. The only control a
    doctor touches is the hardware mute button on the TM20 microphone. This invalidates
    any design that treats a Bench command as a clinician's consent action.

D6. **`pause_day` is operational, not consent** — breaks and gaps between cases, hit by
    an admin. Therefore Linux does NOT kill capture on pause. The Mac does
    (`RoomEngine.swift:3394-3411`: `interrupt()` + `waitUntilExit()`, then a fresh segment
    directory on resume). Linux keeps the single continuous tape advancing and pauses only
    piece cutting and upload. Rationale: the U2 durability guarantee — proven under a hard
    power cut — comes from a capture that never stops. A forgotten resume then loses nothing.
    Because pause carries no privacy promise (D5, D6), paused audio remaining on disk is
    acceptable and is the safer failure.

D7. **Mic mute is detected, reported, and recorded through.** NEW REQUIREMENT with no Mac
    equivalent. When the TM20 hardware mute is engaged, the recorder must signal the Bench
    dashboard, and recording and streaming must CONTINUE unchanged. Mute is an observation
    reported to admins, never a control that stops capture.

---

## 2. Deviations from the Mac, each with its reason

| # | Mac | Linux | Reason |
|---|-----|-------|--------|
| V1 | Per-session segment dirs `captures/<id>/` | One continuous tape `/var/lib/room-recorder/tape` | D6; U2 durability |
| V2 | Device identity = CoreAudio `device_uid` | USB `VID:PID` pinned at enrol | No CoreAudio on Linux; `RoomEngine.swift:3091-3093` matches an opaque string, so Linux defines its own convention (S5) |
| V3 | Self-updater | None | D3 |
| V4 | `RoomControlJournal` | None | Dormant on the Mac: `residentControlJournal` is nil on every fielded machine, every write path a no-op (`RoomEngine.swift:1451-1469`, `:2189-2197`). Porting a file production never writes would be porting a fiction. |
| V5 | Unbounded spool | Capped, re-cut from tape | D1 |
| V6 | No mute concept | Mute detection + report | D7 |
| V7 | `BenchPieceSource.backup` modelled | Not implemented | Dead on the Mac: `PrimaryResidentArchiveCaptureOwner.swift:216-218` throws `.backupNotSupported` unconditionally |

---

## 3. Protocol, as the Mac speaks it

**Enrol.** `POST /api/room-recorder/enrol`, body `{"token": "<bootstrap-token>"}`
(`RoomEnrolment.swift:170-184`). Response `{install_id, room_slug, room_name,
session:{token, expires_at}}` (`:14-35`). Persist order is load-bearing:
`room-session.json` first, then `config.json` re-pointed by `applyEnrolment`
(`:69-106`, `RoomConfiguration.swift:536-559`). Re-enrol keeps the device identity and
resets everything else; the superseded install receives `409 RETIRED` on its next poll
and stops permanently (`RoomEngine.swift:1372-1387`).

**Auth.** `Cookie: eta_room_session=<token>` on every request (`BenchClient.swift`,
`RoomEngine.swift:637`). JWT, 365-day TTL (`RoomKeychain.swift:31`). No refresh call
exists. RULING: Linux does not invent one. Re-enrol is the recovery path, and a room
whose token expires logs it loudly and keeps capturing to tape.

**Origin.** No env var, no config override. Set at enrol from `--origin`, validated
against a compile-time allowlist `www.evenscribe.app` / `evenscribe.app`
(`RoomEnrolment.swift:142-163`), then stored in `config.json`. Linux mirrors this
exactly, allowlist included.

**Poll.** `GET /api/bench/commands` every 1.5 s; on error, backoff 5 s escalating to a
30 s cap (`RoomEngine.swift:1365`, `:1207`, `:1391-1394`). Telemetry rides as query
params on this same GET — there is no separate heartbeat endpoint
(`InstallPollFields.swift`). Ack: `POST /api/bench/commands/<id>/ack`, retried 3x.

**Pieces.** Cut every 4,800,000 samples at 16 kHz mono = 5 minutes exactly, or early at
a discontinuity or session end (`PiecePipeline.swift:233`, `:330-368`). Upload is a
five-step dance: presign `POST /api/bench/upload-url` -> HEAD -> PUT -> HEAD verify ->
register `POST /api/bench/chunks` (`:574-660`). The spool directory IS the ledger —
manifest and media are deleted only after verified registration. Linux keeps this.

**Commands.** Dispatch `RoomEngine.handle(_:)` (`:1624-1706`). A command already in
`completedCommands` is re-acked WITHOUT re-executing (`:1625-1633`) — idempotency is in
the dispatcher, not the handlers, and Linux must reproduce that. The four day-kinds go
through a pure phase-transition table `RoomCommandDecider.decide(kind:phase:overridePause:)`
(`:82-111`). `set_audio_input` bypasses the decider (`:3040-3070`).
`.unknown` acks `ok:false,"unsupported_kind"` and never fails the poll (`:1651-1657`).

**Ack ordering.** Every kind acks AFTER its local effect, with exactly two exceptions:
`check_update_now` and `restart_engine` ack BEFORE, because their effect is process
re-exec or exit (`:2818-2836`, `:2789-2793`). The Linux dispatcher needs an explicit
early-ack hook for those two. Since D3 makes `check_update_now` a no-op, only
`restart_engine` actually uses it.

**States.** `ready, recording, paused, ending, failed, superseded` (`:66-71`).
Linux keeps the same names so Bench-side displays need no change.

**On-disk state.** Mac: `config.json` 0600, `room-session.json` 0600, `status.json`,
`spool/`, `captures/<id>/`. Linux equivalents live under `/var/lib/room-recorder/`
(0750, owned `room-recorder:room-recorder`), with the two secret-bearing files 0600.
No keychain fallback — that is a macOS concept.

---

## 4. What Linux must build that the Mac did not

### S4 — bounded spool
Cap the spool. On exceeding it, delete oldest-first and log each drop with its piece id
and byte range so it can be re-cut. A re-cut path must exist and be tested: given a
piece id and a byte range, re-read from `tape.pcm` and re-enter the upload pipeline.
Cap value is `our-choice` and must be justified in the ruling: proposed 12 h of pieces
(144 pieces at 5 min), measured against the Opus 32 kbit/s bitrate, not guessed.

### S5 — device identity on Linux
The Mac names devices by CoreAudio's opaque `device_uid` and resolves by exact string
match (`RoomEngine.swift:3091-3093`); an absent device refuses the whole command before
mutating anything (`"device_not_present"`). Linux has no such string. RULING: Linux
presents `usb:<VID>:<PID>` as its `device_uid` — for the TM20 today, `usb:0d8c:0134` —
and resolves by exact match against enumerated USB capture devices. Absent device
refuses the command identically, before any mutation. `--expect-usbid` folds into this
at enrol and the interim scaffolding retires.

### S6 — mute detection (D7)
The TM20's hardware mute is bit-exact digital zero. A live TM20 in a silent room is NOT
bit-exact zero — it carries a noise floor. That asymmetry is the detector. Requirements:
- Detect the transition into and out of a sustained bit-exact-zero run.
- The sustain threshold is a `linux-measurement`, not a guess: measure the longest
  bit-exact-zero run a live unmuted TM20 produces in a silent room, and set the
  threshold above it with stated headroom.
- On each transition, write a marker into `tape.idx` and report the new state to the
  Bench.
- Capture, piece cutting and upload CONTINUE THROUGHOUT, unchanged (D7). Mute is
  never a control.
- The muted audio is uploaded like any other audio. It is silence, and silence is a
  true record of the room.

**Server-side dependency, unresolved:** the Mac protocol has no field for this. The
cheapest mirror is an extra query param on the poll GET alongside the existing
`InstallPollFields` telemetry, with the Bench rendering it. That is a change in the
EvenScribe server repo, not this one, and it is NOT in U3's file contract. U3 ships the
detector, the tape marker, and the poll field; the Bench display is tracked separately.

---

## 5. Out of scope for U3
Self-update (D3). RoomControlJournal (V4). Backup pieces (V7). The PIN login path
`POST /room/<slug>/api/login` — it exists on the Mac but no call site in the normal run
loop reaches it; Linux ignores it until something proves it is needed.
