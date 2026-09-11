# ETA Install & Fleet PRD — Release R4 addendum: room audio control from the desk — 11 Sep 2026, 20:05 IST

**Amends** the PRD after B2. Source: carryover 9 Sep §R4 line, carryover 10 Sep §3 item 7, B2-D10. **Decisions are ratified by V or they do
not ship.** No open issues.

## Why tonight
OPD 3 and OPD 7 record bit-exact silence (peak 0 / zero_ratio 1 at 14:03Z) from a TONOR TM20 while a working C270 sits attached in each
room. Nobody can enter a room tomorrow. R4 makes "switch the input to the C270" a paste from the desk, and Home Office is the bench.

## Decisions

| # | Decision | Rationale / evidence |
|---|---|---|
| R4-D1 | **A fifth command kind, `set_audio_input`, on the existing bench command bus.** Args `{device_uid?: string, input_volume?: number 0–1}`, at least one present. Delivered per room like `start_day`; acked with `{applied_device_uid?, applied_input_volume?, input_volume_settable}` or failed with a named reason. | The 0.1.7 constraint is gone: seven Macs on 0.1.20; OPD 1/OPD 4 (0.1.8) are parked and a per-room command never reaches them. Three definitions must move together: `db/migrations/0044:24` CHECK, `lib/bench-commands.ts:23` `COMMAND_KINDS`, `BenchClient.swift:167-172` `BenchCommandKind`. |
| R4-D2 | **The app tolerates unknown kinds from now on.** `BenchCommandKind` decodes unknown strings to `.unknown(raw)`; the engine acks them `failed: unsupported_kind` and keeps polling. | Today an unknown kind fails the whole poll decode (Codable) — the exact 0.1.7 failure mode. Never again. |
| R4-D3 | **Device switch = rewrite `device_uid` in config.json + reopen the capture on the new device without a relaunch.** If a session is open, the tape continues in a new segment under the same `bs_` session; the session id and install id do not change. The C270 must be in `input_devices` (present) or the command fails `device_not_present`. | `AudioDevices.selectDevice` (`:123`) only runs in `CaptureSession.init` (`Recorder.swift:76`); segments (`captures/bs_…/seg_<uuid>/tape.idx`) already exist as the unit of a capture. Config pins the device at enrol (`AudioDevices.swift:169`, V 8 Sep) — R4 is the first thing allowed to change it after enrol. |
| R4-D4 | **Volume: read first, then set.** The app reports `input_volume` (0–1, `kAudioDevicePropertyVolumeScalar`, input scope, master element or channel 1) and `input_volume_settable` (the property is settable) for the device it records from, every poll. A set with `input_volume` on a device that is not settable fails `volume_not_settable` and the card greys the slider. No `osascript`. | 9 Sep flag: the TM20 has a physical gain knob and macOS may not expose gain. The read half answers it on the first poll; nothing is assumed. |
| R4-D5 | **Card control per row:** a device select listing `input_devices` (default marked, current recording device marked) and a volume slider (disabled when not settable), each firing one `POST /api/admin/installs/{installId}/audio-input` with the same body as the command args; the route resolves the install's room, `insertCommand(source:"admin")`, `waitForAck`, and returns the ack. Same guard and error shape as `assign-channel`. | `insertCommand` is source-agnostic (`lib/mcp/tools/bench.ts:471-474`); `assign-channel` is the route template. |
| R4-D6 | **MCP tool `scribe_set_audio_input`** (room, device_uid?, input_volume?) → same enqueue → ack. The orchestrator drives OPD 3/OPD 7 from Cowork with it. | The fleet route is proxy-blocked from Cowork; the MCP door is not. |
| R4-D7 | **Browser kiosk ignores the kind.** `lib/use-command-poll.ts:36` union gains it and the dispatch `default:` ignores it silently (no ack — the native app owns audio). | Third definition of the union; the kiosk must not choke. |
| R4-D8 | **Two builds, parallel, cross-refuted.** R4-S (server: migration 0080, kinds, route, card, MCP tool, kiosk tolerance, tests) in tmux `scribe`; R4-A (app 0.1.21: D2, D3, D4, poll fields, tests) in tmux `scribe2`. Then `/clear` both and swap: `scribe` refutes R4-A, `scribe2` refutes R4-S. Disjoint file sets; nothing shared. | Time. Rule: never two agents editing the same file — they don't. |
| R4-D9 | **Acceptance** = on Home Office (0.1.21 on `test`): (a) `scribe_set_audio_input` device → TM20 ↔ Teams loopback and back while recording — session id unchanged, new segment, card shows the new recording device within a poll; (b) volume set to 0.5 on the TM20 if settable, else the `volume_not_settable` failure lands on the card; (c) the tape's `peak` moves with the device. Then Room 4.1 `test`, then `stable` walk, then **OPD 3 and OPD 7: switch to the C270 from the desk and watch peak leave zero.** | That last line is the whole point of tonight. |
| R4-D10 | Out of scope: loudness, tone self-test, output devices, per-channel volume, any change to enrol. | Order unchanged: loudness → tone after R4. |

## File contracts (rule 2)
**R4-S:** `db/migrations/0080_bench_command_set_audio_input.sql` (drop/re-add the `kind` CHECK with the fifth value) · `lib/bench-commands.ts`
(`COMMAND_KINDS`, arg validation for the new kind) · `lib/bench-bus-constants.ts` (only if a constant is needed) · `lib/room-install.ts`
(poll intake `input_volume` real, `input_volume_settable` bool — columns in 0080; install→room lookup for the route) ·
`app/api/bench/commands/route.ts` (read the two fields) · `app/api/admin/installs/[installId]/audio-input/route.ts` (new) ·
`lib/mcp/tools/bench.ts` (+ `scribe_set_audio_input`) · `lib/use-command-poll.ts` (tolerate) · `lib/room-install-view.ts` (pass-through) ·
`components/admin/BenchInstallFleet.tsx` (control) · `tests/unit/**`. Untouched: `apps/`, release routes, enrol/retire/assign routes.
**R4-A (0.1.21):** `BenchClient.swift` (kind enum + tolerant decode + ack payload) · `RoomEngine.swift` (dispatch, apply, reopen) ·
`RoomConfiguration.swift` (`deviceUID` becomes writable via one method) · `tapewriter/AudioDevices.swift` (volume read/set, settable) ·
`tapewriter/Recorder.swift` (reopen on a new device, new segment) · `InstallPollFields.swift` + `MachineFacts.swift` (two fields) ·
`Tests/**` · `Packaging/VERSION` 0.1.21 · `CHANGELOG.md`. Untouched: `build-bundle.sh`, `RoomSelfUpdate.swift`, enrol path, `TapeFormat.swift`.

## Ratification
**V ratified D1–D10 as written, 11 Sep 2026, 20:05 IST** (both builds started on his word). **R4-D11 (orchestrator ruling 20:12):** the
audio-input route and `scribe_set_audio_input` refuse with 409 `APP_TOO_OLD` unless the bound install's reported `app_version` is ≥ 0.1.21 —
a row delivered to an older app is undecodable and never expires, blocking that room's bus. **R4-D12:** the ack route
(`app/api/bench/commands/[id]/ack/route.ts`) joins the R4-S contract so `applied_device_uid`, `applied_input_volume`, `input_volume_settable`
reach `bench_command.result`.
