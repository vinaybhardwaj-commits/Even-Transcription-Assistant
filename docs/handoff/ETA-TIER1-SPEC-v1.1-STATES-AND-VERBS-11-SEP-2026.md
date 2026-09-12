# ETA Tier 1 Spec v1.1 — Named Room States + Three Operator Verbs (room-recorder 0.1.22, migration 0081)

Status: SPEC v1.1, 11 Sep 2026 21:40 IST. **Supersedes v1.0** (written against a misread base; R4/B2 had already shipped `set_audio_input`, `assigned_channel`, and most heartbeat fields). Base: `vinay/release-b1` @ `d4821ec`, VERSION 0.1.21, migrations through 0080. Delta record: `docs/handoff/ETA-DELTA-5dff406-TO-d4821ec-11-SEP-2026.md`. Rulings D1–D6: `Daily Dash EHRC/ETA/scribe-audit-11-sep/SCRIBE-UPGRADE-PLAN-11-SEP-2026.md §7` (D1 amended here: signing dropped from Tier 1).

## 0. Goal

Two things, in this order of value: (1) a room that is recording silence, clipping, on the wrong device, with a stalled encoder or a filling disk becomes a **named state** on the server within one poll — using fields the app already sends; (2) three verbs that today need a person or a 6 h wait: `check_update_now`, `report_diag`, `restart_engine`, plus letting `assigned_channel` carry `'test'`.

## 1. Scope

In: `lib/room-facts` (or wherever `scribe_diff_room` derives `ENDED_DISAGREES` — Builder locates), `lib/bench-bus-constants.ts`, `lib/bench-commands.ts`, `lib/room-install.ts` / `room-install-view.ts`, `app/api/bench/commands/route.ts`, `app/api/admin/bench/command/route.ts`, `app/api/admin/installs/[installId]/assign-channel/route.ts`, `lib/mcp/tools/bench.ts` (one tool), `components/admin/BenchInstallFleet.tsx` (state chip only), migration 0081, Swift `BenchClient.swift`, `RoomEngine.swift`, `RoomSelfUpdate.swift`, `RoomConfiguration.swift`, `InstallPollFields.swift`, tests.
Out: HMAC signing of command rows (deferred; R4 set the trust model = admin/MCP auth at insert), enrol-without-walk, per-room silence floor calibration (R2.5), MCP regroup/jobs (Tier 2), the R4-S open flag on browser-tab listeners holding a `LIMIT 20` slot (B3 carries it).

## 2. Slice A — named states (server only; ships first, no app change)

Inputs already on `room_install` per poll: `peak`, `zero_ratio`, `tape_advancing`, `session_open`, `disk_free_bytes`, `input_device_name`, `input_devices` (jsonb), `update_channel`, `assigned_channel`, `last_update_*`, `app_version`; on `bench_listener`: `last_poll_at`, `recording_session_id`, `mic_peak`, `mic_avg`.

| state | rule (evaluated per poll, stored as `room_install.state_flags jsonb` + `state_changed_at`) |
|---|---|
| `SILENT_WHILE_RECORDING` | `recording_session_id` set && `tape_advancing` && `zero_ratio ≥ 0.98` for ≥ `SILENT_POLLS` (default 80 polls ≈ 2 min at 1.5 s) |
| `CLIPPING` | recording && `peak ≥ 0.99` in ≥ 3 of the last 10 polls |
| `DEVICE_MISSING` | `input_device_name` not present in `input_devices[].name` |
| `DEVICE_CHANGED` | `input_device_name` ≠ the name recorded at the last `set_audio_input` ack or enrol (`room_install.expected_device_name`, new column) |
| `ENCODER_STALLED` | recording && `tape_advancing == false` for ≥ 4 consecutive polls |
| `DISK_LOW` | `disk_free_bytes < 2 GiB` |
| `CHANNEL_DRIFT` | `assigned_channel` set && `update_channel ≠ assigned_channel` for > 30 min |

Rolling windows (last 10 polls) live in `room_install.poll_ring jsonb` (capped array of `{at, peak, zero_ratio, tape_advancing}`), written in the same `applyInstallPoll` UPDATE — no extra round trip (B2-S fix-up rule). Constants in `lib/bench-bus-constants.ts` with the documentary header style. Surfaces: `scribe_diff_room` (`room_state.flags[]`), `/api/admin/bench/fleet` row, fleet card chip. Per-room floors (9 Sep finding) come later; these are coarse alarms. Migration 0081: `state_flags`, `state_changed_at`, `poll_ring`, `expected_device_name`.

## 3. Slice B — verbs (server + app 0.1.22)

`COMMAND_KINDS` (bench-commands.ts:28), the 0081 CHECK, and `BenchCommandKind` (BenchClient.swift:179-218) gain, in lock-step:

| kind | args | app action | ack `result` / refusals |
|---|---|---|---|
| `check_update_now` | `null` | `checkForUpdateIfDue(force: true)` — bypasses `checkInterval` only; still defers while `session_open` (R3-10) | `{checked_at, offered_version?, deferred}` |
| `report_diag` | `{log_lines?: int ≤ 500}` | app version, build sha, config minus `etaRoomSession`, tapewriter/ffmpeg `--version`, `input_devices`, disk, last N log lines, update ledger | payload in `result`; ack wait 20 s for this kind |
| `restart_engine` | `{force?: bool}` | refuse `session_open` unless `force`; ack first, then `exit(0)` for launchd relaunch | `{restarting: true}` |

Rules: all refusals ack `ok:false, status:"failed", error:<name>` (matches R4's `unsupported_kind` path); version floor `0.1.22` enforced server-side like D11 (`appVersionAtLeast`); `.unknown(String)` means a 0.1.21 app acks `unsupported_kind`, not a broken poll. Admin route `POST /api/admin/bench/command` accepts the kinds with zod-validated args; MCP `scribe_room_command(room, kind, args?)` (scope `write`) via `sendAndWait`.

`assign-channel` route: extend 0079's CHECK to `('stable','test')`. App: `RoomConfiguration.channelLocked: Bool = false` (config.json); when true, the poll's `assigned_channel` is ignored and the app reports `channel_locked=true` (new poll field) so the fleet card shows why. This is the D1 override, unsigned.

App heartbeat additions (InstallPollFields): `clip_count` (full-scale samples in the last poll interval), `silence_ms` (ms since last frame above `−55 dBFS`), `channel_locked`. Server reads them in `commands/route.ts` and stores on `room_install` (0081). `SILENT_WHILE_RECORDING` and `CLIPPING` prefer these when present, fall back to `zero_ratio`/`peak` for 0.1.21 apps.

## 4. Tests

Server: `bench-room-states.test.ts` (every rule at boundary, ring rollover, 0.1.21 fallback), `bench-commands-new-kinds.test.ts` (args schemas, version floor, ack shapes), `room-install-assign-test-channel.test.ts`, `mcp-room-command.test.ts`. Gate: 1678 → all pass + new.
App: `RoomOperatorVerbTests` (force-check bypasses interval only; restart refuses while open; report_diag never contains `etaRoomSession` or Keychain material; `channelLocked` ignores assigned channel), heartbeat encoding. Gate: 582 in 47 suites → all pass + new.
Acceptance on Home Office (`test`): (1) mute the TONOR 3 min → `SILENT_WHILE_RECORDING` in `scribe_diff_room`, clears within 10 polls of unmute; (2) set `channelLocked:true`, assign `stable` → fleet shows `channel_locked`, app stays on `test`; (3) `check_update_now` with 0.1.23 on `test` → swap inside the canary window; (4) `report_diag` returns devices + last 100 log lines and no secret; (5) `restart_engine` while idle → listener gap < 15 s.

## 5. Rollout

Slice A first: migration 0081 + server, no app dependency — states appear for the six 0.1.21 rooms immediately. Slice B: 0.1.22 → `test` (Home Office, Room 4.1) → the six partition steps → Cardiology → `stable`. Never `stable` before the partition steps.

## 6. Builder brief (Claude Code on the Mini, tmux `scribe`)

Goal §0. Scope §1. Branch `vinay/tier1-states` from `d4821ec` (HEAD; no stash needed — the memory file edit carries over). Allowed: files in §1 + new tests. Order: Slice A commits, run `pnpm test`, then Slice B server, then app, `swift test`, `pnpm tsc --noEmit`. Do not: publish to any channel, run 0081 against production, change `LISTENER_FRESH_MS`/`ACK_WAIT_MS` for existing kinds, touch `lib/stt`, or `lib/mcp` beyond one tool. Output: `docs/handoff/ETA-TIER1-BUILD-REPORT-<date>.md` ≤ 60 lines — commits, test counts, every seam interpreted differently from this spec.

## 7. Refuter brief (Opus, separate CC session or Cowork agent, never the Builder)

Diff `d4821ec..vinay/tier1-states` against this spec. Rerun all three gates. Attempt: a 0.1.21 poll must still write states (fallback path); `SILENT_WHILE_RECORDING` must not fire on a paused room; `restart_engine` without `force` during `session_open` must refuse; `report_diag` output grep for `eta_room_session`, `etaRoomSession`, `commandVerifyKey`, `SCRIBE_MCP_TOKEN` must be empty; `assigned_channel='test'` must round-trip in the poll response. Verdict ≤ 40 lines: PASS/FAIL per §4 acceptance item, defects with file:line, safe-for-`test` yes/no.
