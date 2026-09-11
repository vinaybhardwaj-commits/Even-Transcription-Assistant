# ETA KICKOFF — R4-A "Room Recorder 0.1.21: set_audio_input, app half" — 11 Sep 2026, 20:10 IST

Builder brief for Claude Code on the Mini, **tmux `scribe2`, after `/clear`**. R4-S builds in parallel in `scribe` on a disjoint file set —
touch nothing outside `apps/room-recorder/` and `docs/handoff/`. Refuter later = `scribe` after its own `/clear`. Spec =
`docs/handoff/ETA-INSTALL-AND-FLEET-PRD-RELEASE-R4-ADDENDUM-11-SEP-2026.md` decisions D1–D4; read it first. Passwords never through `!`;
V unlocks the keychain in a Terminal window before the build. Nothing publishes without V.

## Goal
0.1.21 accepts `set_audio_input` from the bus: switches the recording device without a relaunch and without ending the session, reads
and (where the device allows) sets input volume, reports both every poll, and never again fails a poll on an unknown command kind.

## Known facts (verified 11 Sep, Researcher 19:58)
- HEAD = origin `07dabbf`. `Packaging/VERSION` 0.1.20 → **0.1.21**. `swift test` 563 / 45 at `74a79ea` (CLT plugin flags).
- Wire kinds: `BenchClient.swift:167-172` `enum BenchCommandKind: String, Codable` (four cases); `CommandPollResponse.commands: [BenchCommand]`
  `:175-186` — an unknown `kind` string fails the whole decode today. Dispatch: `RoomEngine.swift:1472` `handle(_:)`, `switch command.kind`
  `:2177`; ack `RoomEngine.swift:1903` → `BenchClient.swift:500 acknowledge(...)`. `ArchiveControlCommandKind` (`TapeCore/ArchiveControlPayload.swift:3-14`)
  is the internal state machine, NOT the wire — leave it.
- Device: config.json `device_uid` = `RoomConfiguration.deviceUID` (`:34,48`; doc `:217,:230`); set once at enrol (`AudioDevices.swift:169`).
  `AudioDevices.selected(uid:)` `:13`, `isDefaultInput` `:23`, `presence(uid:)` `:39`, `all()` `:44`, `defaultInputID()` `:69` (read-only),
  `selectDevice(_:on:)` `:123` sets `kAudioOutputUnitProperty_CurrentDevice` on the engine's input unit — called only from
  `CaptureSession.init` (`tapewriter/Recorder.swift:76`). `list()` `:186` (B2-D10). No `kAudioDevicePropertyVolumeScalar` anywhere.
- Segments: a capture writes `captures/<bs_id>/seg_<uuid>/tape.idx` — the segment is the unit of one `CaptureSession`.
- Poll fields: `InstallPollFields.swift:203` `input_device_name`, `:228-229` `input_devices`; caps `:244`. Reporting reader
  `MachineFacts.swift:88-92`. Tests: `RoomInstallDeviceTests.swift`, `RoomEngineResidentCaptureTests.swift` (fake poll JSON with commands,
  e.g. `:298`), `ArchiveControlPayloadTests.swift:412` (invalid-kind rejection pattern).
- Server args (R4-S, being built now): `{device_uid?: string, input_volume?: number 0–1}`; ack payload the app must send on success:
  `{applied_device_uid?, applied_input_volume?, input_volume_settable: bool}`; failure reasons: `device_not_present`, `volume_not_settable`,
  `unsupported_kind`, `bad_args`.

## Exact scope
1. **D2 tolerant decode.** `BenchCommandKind` gains `case setAudioInput = "set_audio_input"` and `case unknown(String)`; custom `init(from:)`
   maps any other string to `.unknown`. Engine acks `.unknown` as failed `unsupported_kind` and continues. Test: a poll carrying
   `"kind":"frobnicate"` beside a `start_day` still dispatches the `start_day` and acks the other failed.
2. **D3 device switch.** On `set_audio_input` with `device_uid`: if not in `AudioDevices.list()` → ack failed `device_not_present`. Else
   write `deviceUID` to config.json through one new `RoomConfiguration` method (atomic write, 0600, no other key touched — reuse the
   existing writer), then, if a capture is running, close the current `CaptureSession` and open a new one on the new device in a **new
   segment of the same session** (session id unchanged; no `end_day`); if idle, nothing more. Ack `applied_device_uid`. Tests: (a) idle switch
   → config rewritten, next poll's `input_device_name` is the new device; (b) recording switch → a second `seg_` directory appears, session
   id unchanged, no gap longer than one checkpoint in `tape.idx` timing; (c) unknown uid → `device_not_present`, config untouched.
3. **D4 volume.** `AudioDevices`: `inputVolume(uid:) -> (value: Float, settable: Bool)?` and `setInputVolume(uid:, value:) throws` using
   `kAudioDevicePropertyVolumeScalar`, scope input, element master (fall back to channel 1 if master is absent), `AudioObjectIsPropertySettable`
   for `settable`. Command with `input_volume`: clamp 0–1; if not settable → ack failed `volume_not_settable`; else set, re-read, ack
   `applied_input_volume` with the re-read value. Tests with a fake device table for both branches; one real-hardware assertion in the
   report (TM20 on the Mini: settable true/false and the value).
4. **Poll fields.** `input_volume` (4 decimals) and `input_volume_settable` for the device the app records from (`deviceUID`), beside
   `input_device_name`; null when the device is absent. Test in `RoomInstallDeviceTests`.
5. `Packaging/VERSION` → `0.1.21`; CHANGELOG: `- **0.1.21** — set_audio_input: switch the recording device and set input volume from the
   desk; unknown command kinds are ignored, never fatal.`

Out of scope: output devices, per-channel volume, enrol, self-update, the swap script, `TapeFormat.swift`.

## Allowed changes
`apps/room-recorder/Sources/RoomRecorderCore/{BenchClient,RoomEngine,RoomConfiguration,InstallPollFields,MachineFacts}.swift` ·
`apps/room-recorder/Sources/tapewriter/{AudioDevices,Recorder}.swift` · `apps/room-recorder/Tests/**` · `Packaging/VERSION` · `CHANGELOG.md` ·
`docs/handoff/` (this kickoff, your report). A file outside this list that must change → STOP and name it (rule 2 — the capture-owner
files `PrimaryResidentArchiveCaptureOwner.swift` / `ResidentAudioCaptureLane.swift` are the likely candidates; name them, do not edit
until ruled).

## What to verify
`swift test` count (563 before); every new test failing before / passing after; build + sign (`Packaging/build-bundle.sh
"$PWD/.build/release-bundle-0.1.21"`, keychain unlocked by V); the six checks with exit codes (leaf verify, DR = 0.1.20's, CDHash,
plist 0.1.21, `anchor trusted` 0/0/0, sha256 = release.json). Stage and stop. Do not publish, push, touch any room or LaunchAgent, or
enqueue anything.

## Output
`docs/handoff/ETA-R4-A-BUILD-REPORT-11-SEP-2026.md` ≤350 words: sha; `--stat`; counts; tests by name with fail→pass; the TM20 volume
reading on the Mini; the six checks; artifact path/sha256/size/CDHash; deviations. Commit on `vinay/release-b1` with this kickoff. Chat:
sha, count, CDHash, sha256, artifact path, TM20 settable? — deviations only beyond that.

## Refuter brief (tmux `scribe`, after `/clear`, after R4-S is committed)
Diff = the app files only. Rerun the suite; unpack the zip and rerun the six checks. Adversarial, quote lines: (1) can a device switch
end or orphan the bench session, or leave two captures open? (2) can the config write drop keys or leave a partial file? (3) can an
unknown kind still fail the poll decode anywhere (e.g. `args` shape)? (4) can `setInputVolume` write outside 0–1 or to the wrong scope
(output)? (5) if the new device disappears mid-switch, what is left recording? Verdict ≤200 words to
`docs/handoff/ETA-R4-A-REFUTER-VERDICT-11-SEP-2026.md`.
