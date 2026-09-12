# ETA Tier 1 Spec — Kiosk Verb Extension + Content-Aware Heartbeat (room-recorder 0.1.17)

Status: SPEC v1.0, 11 Sep 2026. Rulings D1–D6 in `SCRIBE-UPGRADE-PLAN-11-SEP-2026.md §7`. Base: `/Volumes/MiniDev/Even-Transcription-Assistant` @ `5dff406`, migrations through 0078, room-recorder `Packaging/VERSION` 0.1.16.

## 0. Goal

Every adjustment that today requires a person at the Mac — switch input device, move a room between `stable`/`test`, force an update check, restart the engine, pull a diagnostic — becomes a signed command on the existing 1.5 s poll bus. Every poll carries enough about the audio *content* that a room recording silence, clipping, or the wrong device is a named state on the server within 10 s.

## 1. Scope

In: Swift `RoomRecorderCore` (BenchClient, RoomEngine, RoomConfiguration, RoomSelfUpdate), `lib/bench-commands.ts`, `lib/bench-bus-constants.ts`, `app/api/bench/commands/**`, `app/api/admin/bench/command/route.ts`, one migration (0079), `lib/room-facts` state derivation, `lib/mcp/tools/bench.ts` (one new tool), tests.
Out (later tiers): MCP regroup, async jobs, drain cron, audio-join measurement, enrol without a walk (stays local), any UI beyond the existing monitor's state chips.

## 2. Command vocabulary

`BenchCommandKind` (BenchClient.swift:171-176) and `COMMAND_KINDS` (bench-commands.ts:23) gain, in lock-step:

| kind | args | kiosk action | ack `result` |
|---|---|---|---|
| `check_update_now` | — | run `checkForUpdateIfDue()` with the 6 h gate bypassed; still deferred while a session is open (R3-10 unchanged) | `{checked_at, offered_version?, deferred: bool}` |
| `set_update_channel` | `{channel: "stable"\|"test"}` | write `updateChannel` via `saveConfiguration` unless `channelLocked == true` → refuse `channel_locked` | `{channel, previous}` |
| `list_input_devices` | — | enumerate CoreAudio input devices (uid, name, manufacturer, is_default, sample_rate, channels) | `{devices:[…], current_uid}` |
| `set_input_device` | `{device_uid}` | refuse `unknown_device` if not enumerable; refuse `session_open` if recording (unless `args.force`); write `deviceUID`, restart capture | `{device_uid, previous}` |
| `report_diag` | `{log_lines?: int ≤ 500}` | app version, build sha, config (secrets stripped: never `etaRoomSession`), tapewriter/ffmpeg paths + `--version`, disk free, last N log lines, current device, last update ledger | `{…}` |
| `restart_engine` | — | ack first, then `exit(0)` so launchd relaunches; refuse `session_open` unless `force` | `{restarting: true}` |

Rules: (a) every new kind is refused with `session_open` while a tape is running unless `args.force === true`, except `check_update_now` (defers) and `report_diag` (always allowed); (b) all refusals ack with `ok:false, status:"refused", error:<name>` — never silent expiry; (c) `end_day`/`pause_day`/`resume_day` semantics untouched.

## 3. Signing (D1)

- New env `BENCH_COMMAND_SIGNING_KEY` (32 bytes, Vercel only). `insertCommand` computes `sig = HMAC-SHA256(key, room_id|kind|canonical_json(args)|nonce|expires_at)` and stores `nonce`, `expires_at`, `sig` on the row. Legacy kinds are signed too, but the kiosk only *enforces* on new kinds (so a 0.1.16 room keeps working against the new server).
- Kiosk: `RoomConfiguration` gains `commandVerifyKey: String?`, delivered once at enrol in the `/api/room-recorder/enrol` response and stored in Keychain beside `etaRoomSession` (never in config.json). A kiosk without a key refuses every new kind with `unsigned_room` — visible, not silent.
- Verify: recompute HMAC, check `expires_at` ≥ now − 60 s skew, keep a 200-entry nonce ring; replay → `replayed`.
- `channelLocked: Bool` (default false) in config.json is honoured *before* signature: a locked room refuses `set_update_channel` even with a valid signature. This preserves the original "valve on the other side of the wire" argument for any room V pins by hand.

## 4. Heartbeat (content-aware poll)

`pollCommands` (BenchClient.swift:427-465) already sends `mic_peak, mic_avg, spare_peak, spare_avg, spare_device` + install fields. Add query params, all optional so old servers ignore them:

| param | source | purpose |
|---|---|---|
| `device_uid` | `configuration.deviceUID` | detect device swap / OS default drift |
| `device_present` | CoreAudio lookup of `deviceUID` | detect unplugged mic while "recording" |
| `clip_count` | samples at full scale in the last poll interval (from the level pipeline that already produces `BenchLevelPair`) | clipping (OPD 3 case) |
| `silence_ms` | ms since last frame with RMS above `SILENCE_RMS_DBFS` (−55 dBFS default, per-room override later) | dead mic / mute (9 Sep case) |
| `encoder_ok` | tapewriter subprocess alive + last chunk write age < 2× chunk period | encoder wedge |
| `disk_free_mb` | statfs on the archive volume | ENOSPC before it happens |
| `channel` | `updateChannel` | fleet view shows which channel each Mac reads |
| `channel_locked` | `channelLocked` | as above |

Server: migration 0079 adds the matching nullable columns to `bench_listener` (+ `heartbeat_at`). GET route (app/api/bench/commands/route.ts) writes them like the 0066 level fields.

Named states (derived in `lib/room-facts`, surfaced in `scribe_diff_room`, `/admin/bench/fleet`, and the monitor beside `ENDED_DISAGREES`):

| state | rule |
|---|---|
| `SILENT_WHILE_RECORDING` | recording && `silence_ms` > 120 000 |
| `CLIPPING` | recording && `clip_count` > 0 in ≥ 3 of the last 10 polls |
| `DEVICE_MISSING` | `device_present == false` |
| `DEVICE_CHANGED` | `device_uid` ≠ the uid stored on `room_install` for that install |
| `ENCODER_STALLED` | recording && `encoder_ok == false` |
| `DISK_LOW` | `disk_free_mb` < 2048 |
| `UNSIGNED_ROOM` | listener reports `app_version` ≥ 0.1.17 and has ever acked `unsigned_room` |

Thresholds live in `lib/bench-bus-constants.ts` with the same documentary style as the existing constants. Per-room calibration (9 Sep finding: no global floor works) is *not* in this slice; the state is a coarse alarm, the per-room floor comes with R2.5.

## 5. Server write path

- `POST /api/admin/bench/command` (route.ts:90 kinds check): accept the new kinds + `args`; validate args per kind with zod; sign; audit as today.
- `decideStart`-style pre-checks for new kinds: `kiosk_not_listening` (same 10 s rule), `app_too_old` if listener `app_version` < 0.1.17, `channel_locked` short-circuit if the listener reported `channel_locked=true`.
- MCP: one new tool `scribe_room_command(room, kind, args?, force?)` in `lib/mcp/tools/bench.ts` using `sendAndWait` (bench.ts:470-501), scope `write`, same ack/`ack_timeout` semantics as `scribe_start_recording`. `report_diag` is the only kind whose result may exceed 8 s — set its `ACK_WAIT_MS` to 20 s.

## 6. Kiosk changes (Swift)

1. `BenchClient.swift`: enum cases; `BenchCommand` gains `nonce: String?`, `expiresAt: String?`, `sig: String?`; `CommandAcknowledgement` gains `result: JSONValue?`, `error: String?`; new heartbeat fields on `pollCommands`.
2. `RoomEngine.swift:1419-1478 handle(_:)`: new cases; signature verification before dispatch; `session_open`/`force` gate; all refusals ack.
3. `RoomConfiguration.swift`: `channelLocked: Bool = false`; `commandVerifyKey` never serialised (same strip as `etaRoomSession`, :410-422); Keychain read/write in `RoomKeychain.swift`.
4. `RoomSelfUpdate.swift:938 checkForUpdateIfDue`: add `force: Bool = false` that bypasses `checkInterval` only.
5. New `AudioDevices.swift`: CoreAudio enumeration (`kAudioHardwarePropertyDevices`, input streams > 0), presence check by uid.
6. Level pipeline: wherever `BenchLevelPair` is produced, also count full-scale samples and track last-above-threshold timestamp; expose `clipCount`, `silenceMs`.
7. `Packaging/VERSION` → 0.1.17. Enrol response parsing for `command_verify_key`.

## 7. Tests

Server (vitest): kinds validation + arg schemas; HMAC sign/verify round-trip incl. expiry and replay; listener heartbeat columns written; each named state rule true/false at boundary; `scribe_room_command` ack/refusal/`app_too_old`; `channel_locked` short-circuit. Extend `bench-commands.test.ts`, add `bench-heartbeat-states.test.ts`, `bench-command-signing.test.ts`.
Swift (`TapeCoreTests` gate stays green; new `RoomRecorderCoreTests`): signature verify (good/expired/replayed/unsigned_room); `set_input_device` refusals; `channelLocked` precedence; heartbeat field encoding; `report_diag` never includes `etaRoomSession` or the verify key.
Acceptance on Home Office (`test` channel): (1) `scribe_room_command list_input_devices` returns the TONOR + built-in; (2) `set_input_device` to built-in while idle → next chunk's level profile changes; (3) mute the mic 3 min → `SILENT_WHILE_RECORDING` in `scribe_diff_room` within 10 s of threshold; (4) `set_update_channel stable` on a `channelLocked` room → `channel_locked`; (5) `check_update_now` with 0.1.18 on `test` → swap within canary window; (6) tamper one byte of `sig` in DB → `bad_signature` ack.

## 8. Rollout

0.1.17 → `test` → Home Office → the six partition steps → Cardiology `test` → `stable`. Migration 0079 and the server release ship first (backward-compatible: old kiosks ignore new columns/kinds). `BENCH_COMMAND_SIGNING_KEY` set in Vercel before the server deploy; enrol hands the key only to ≥ 0.1.17 kiosks. Still gated behind the OPD visit and the `room-session.json` fix — never to `stable` before those.

## 9. Builder brief (Sonnet)

Goal §0. Scope §1. Allowed changes: only the files in §1 plus new test files and `AudioDevices.swift`. Build in the MiniDev clone on a branch `vinay/tier1-verbs` off `5dff406`; do not touch `stable`/`test` channels or publish anything. Verify: `pnpm test` (all 66+ suites), `swift test` in `apps/room-recorder` (283 + new), `pnpm tsc --noEmit`. Do not: change poll cadence, `LISTENER_FRESH_MS`, `ACK_WAIT_MS` for legacy kinds, `end_day` semantics, or anything under `lib/stt`, `lib/mcp` beyond the one tool. Output: commit list + test counts + a ≤40-line report naming every seam you had to interpret differently from this spec. Known facts: §2–§6 line numbers are from `5dff406`; poll already carries level fields (mig 0066); config.json strips `etaRoomSession` at :410-422; enrol is `RoomEnrolment.exchange`.

## 10. Refuter brief (Opus)

Review the diff against this spec; rerun all three test commands yourself; attempt: replay a captured signed command; send `set_update_channel` to a `channelLocked` room; send a new kind to a 0.1.16 listener; make `report_diag` leak a secret; drive `silence_ms` across 120 000 and confirm the state flips both ways. Output ≤40 lines: PASS/FAIL per §7 acceptance item, defects with file:line, and whether the diff is safe to publish to `test`.
