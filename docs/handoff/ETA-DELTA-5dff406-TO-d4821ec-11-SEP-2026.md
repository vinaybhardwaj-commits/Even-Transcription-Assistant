# ETA DELTA — `5dff406` → `d4821ec` — 11 Sep 2026

Read-only survey of `vinay/release-b1`, from `5dff406` (room-recorder 0.1.16, B1 ledger-hold proof) to `d4821ec` (HEAD, R4 rollout docs).
25 commits, 85 files, +8981/−290. The Builder wrote it on the Mini. No code changed, nothing committed. Line numbers are at `d4821ec`.

## 1. Commits and diff

`git log --oneline 5dff406..HEAD`:
```
d4821ec docs: R4 rollout complete; OPD 3 and OPD 7 on C270 from the desk
5ff2ae0 docs: R4-S and R4-A Refuter verdicts
39463d8 docs: R4-A build report
55be1d1 docs: orchestrator memory rules 27–32; EOD B2 carryover
5af9075 room-recorder: 0.1.21 — R4-A set_audio_input, app half
8f1f481 docs: R4-S build report fix-up section
9f11bbd R4-S fix-up: D11 app-version floor, D12 ack applied fields
84deae6 docs: R4-S build report
6df15d7 R4-S: set_audio_input — server half
07dabbf docs: 0.1.20 rollout complete; stale releases withdrawn
06708c1 docs: B2-A Refuter verdict
de75616 docs: B2-A build report
74a79ea room-recorder: 0.1.20 — Release B2 app half
47733a2 docs: B2-S in production
e908b84 docs: handoff bus 9–11 Sep (kickoffs, reports, carryovers, orchestrator memory)
d03ae76 docs: B2-S verdict; retire the session-migration runbook
0b9757a fleet: B2-S fix-up — assignment clears itself, device limits, no extra poll read
0f6dd89 docs: B2-S build report
a503da0 fleet: B2-S — one row per room, the receipt's sentence, Move to stable, disk levels
4fbf6d0 docs: 0.1.19 fleet rollout complete
d2e9ef3 docs: 0.1.19 build report and Refuter verdict
da58a4c room-recorder: 0.1.19 — first clinic self-update
faafd04 room-recorder: 0.1.18 Refuter verdict — ACCEPT 964e426
964e426 room-recorder: 0.1.18 — the self-update verifier pins the leaf alone
5a36727 room-recorder: 0.1.17 — a re-enrolled Mac never polls as a retired install id
```

`git diff --stat 5dff406..HEAD`, by area (from `--numstat`; the totals reconcile to 85 files, +8981/−290):

| Area | Files | + / − |
|---|---|---|
| apps/room-recorder | 23 | +3442 / −155 |
| lib/ | 5 | +708 / −50 |
| app/api/ | 4 | +190 / −3 |
| db/migrations | 2 | +129 / −0 |
| docs | 41 | +2499 / −59 |
| components/ (not one of the five named areas) | 1 | +321 / −18 |
| tests/ (not one of the five named areas) | 9 | +1692 / −5 |

**apps/room-recorder.** Sources: `RoomRecorderCore/RoomEngine.swift` +671/−67 · `BenchClient.swift` +129/−7 · `InstallPollFields.swift` +104/−3 ·
`RoomEnrolment.swift` +57/−0 · `RoomSelfUpdate.swift` +55/−5 · `RoomSessionStore.swift` +50/−1 · `RoomConfiguration.swift` +44/−2 ·
`MachineFacts.swift` +29/−3 · `tapewriter/AudioDevices.swift` +135/−6 · `tapewriter/TapeWriter.swift` +61/−14 · `TapeCore/TapeFormat.swift` +21/−1 ·
`RoomRecorderCLI/main.swift` +10/−25. Packaging: `VERSION` +1/−1 · `build-bundle.sh` +3/−3 · `CHANGELOG.md` +8/−0.
Tests (`Tests/TapeCoreTests/`): `RoomAudioInputCommandTests` +584 (new) · `RoomStaleIdentityTests` +367 (new) · `RoomCommandKindToleranceTests` +345 (new) ·
`RoomSelfUpdateTests` +282/−17 · `ReleaseB2TapeMeasurementTests` +247 (new) · `RoomInstallDeviceTests` +170 (new) · `IndexLogTests` +48 · `RoomSessionStoreTests` +21.

**lib/.** `room-install.ts` +261/−39 · `room-install-view.ts` +220/−1 · `bench-commands.ts` +147/−6 · `mcp/tools/bench.ts` +65/−0 · `use-command-poll.ts` +15/−4.

**app/api/.** `admin/installs/[installId]/audio-input/route.ts` +109 (new, R4-S) · `admin/installs/[installId]/assign-channel/route.ts` +58 (new, B2-S) ·
`bench/commands/route.ts` +16/−1 · `bench/commands/[id]/ack/route.ts` +7/−2.

**db/migrations.** `0079_install_assigned_channel.sql` +51 (B2-S) · `0080_bench_command_set_audio_input.sql` +78 (R4-S).

**components/, tests/.** `components/admin/BenchInstallFleet.tsx` +321/−18. `tests/unit/`: `room-install-b2` +441 · `room-install-audio-input` +402 ·
`bench-commands-set-audio-input` +257 · `room-install-reason-route` +253 · `mcp-set-audio-input` +154 · `room-install-assign-route` +97 ·
`bench-ack-applied` +71 · `room-install-update` +13/−5 · `bench-orphan` +4.

**docs** (all `docs/handoff/ETA-*`; 40 new files, 1 edited):
- Build reports (7): 0.1.17, 0.1.18, 0.1.19, B2-A, B2-S, R4-A, R4-S. Refuter verdicts (7): the same seven. 0.1.17 Refuter kickoff (1).
- Kickoffs (7): 0.1.17 stale session id, 0.1.18 drop anchor trusted, 0.1.19 first clinic self-update, B2-A app 0.1.20, B2-S fleet server, R4-A app 0.1.21, R4-S audio-input server.
- Older verdicts (3): B1-B1.5 acceptance, R3 acceptance, R3-FIX2. PRD addenda (3): R3-5, Release B2, Release R4.
- Carryovers (4): 9 Sep EOD, 10 Sep EOD, 11 Sep EOD, 11 Sep EOD-B2. Orchestrator memory (1, +128).
- Runbooks (4): 0.1.8 console, hospital paste, OPD visit, session migration (edited +66/−59, retired in `d03ae76`). Room notes (4): OPD 1, OPD 4, OPD 7 bring-up; OPD 6 check.

## 2. Command kinds and args

App, `apps/room-recorder/Sources/RoomRecorderCore/BenchClient.swift:179–218`. `enum BenchCommandKind: RawRepresentable, Codable` (it was `String, Codable` before R4-A):

| Case | Line | Raw value (init / rawValue) |
|---|---|---|
| `startDay` | :180 | `"start_day"` :190 / :201 |
| `pauseDay` | :181 | `"pause_day"` :191 / :202 |
| `resumeDay` | :182 | `"resume_day"` :192 / :203 |
| `endDay` | :183 | `"end_day"` :193 / :204 |
| `setAudioInput` | :185 | `"set_audio_input"` :194 / :205 |
| `unknown(String)` | :186 | any other string :195 / :206. The engine acks it `failed: unsupported_kind` (comment :177–178) |

`BenchCommand.args: JSONValue` (:223). An absent `args` decodes to `.null` (:240). A command that can't be decoded is dropped on its own (`DecodedBenchCommand`, :248–254).
The engine dispatches at `RoomEngine.swift:1545` (four day verbs), `:1547` (`setAudioInput`) and `:1552` (`unknown`).

Server, `lib/bench-commands.ts:28`: `COMMAND_KINDS = ["start_day", "pause_day", "resume_day", "end_day", "set_audio_input"]`. The same five as the 0080 CHECK.

| Kind | Args shape | Where |
|---|---|---|
| `start_day` | `{ override_pause: true }` or `null` | `decideStart`, `bench-commands.ts:566,583`. App reads it at `RoomEngine.swift:1565` |
| `pause_day`, `resume_day`, `end_day` | `null` in practice. `insertCommand` does not validate these four (`:480`) | admin route `app/api/admin/bench/command/route.ts:152` inserts no args |
| `set_audio_input` | `{ device_uid?: string; input_volume?: number }` (`SetAudioInputArgs`, `:32`) | `parseSetAudioInputArgs`, `:51–69` |

`set_audio_input` rules on the server:
- The args must be an object with no other keys. `device_uid` is trimmed to 1..256 characters. `input_volume` must be finite and in 0..1, and is refused, not clamped. At least one of the two must be present.
- `insertCommand` validates again (`:481`), so no path onto the bus can skip the check.
- Version floor: `SET_AUDIO_INPUT_MIN_APP_VERSION = "0.1.21"` (`:76`), compared numerically (`appVersionAtLeast`, `:86`). Below it, the route answers 409 and the tool returns `APP_TOO_OLD`.

On the app side, `AudioInputRequest.parse` (`RoomEngine.swift:2646`) clamps an out-of-range volume instead of refusing it (comment `:2645`). The server refuses first, so only a hand-written insert would reach the clamp.
The `set_audio_input` ack adds `applied_device_uid`, `applied_input_volume` and `input_volume_settable` (`BenchClient.swift:614–616`). The server reads them with `cleanAckApplied` (`bench-commands.ts:127`).
The browser kiosk (`lib/use-command-poll.ts`) lists the kind in its union but ignores it without an ack (R4-D7).

## 3. bench_listener, bench_command and the poll

The grep for `bench_listener|bench_command` over `db/migrations/*.sql` hits 0044, 0066, 0068, 0069, 0070, 0075 and 0080. After 0066, only 0068 adds a column.

**bench_command.** 0044:22–33. No column added since. 0080:60–62 only swaps the `kind` CHECK.
`id text PK` · `room_id text NOT NULL → room(id)` · `kind text NOT NULL CHECK (kind IN ('start_day','pause_day','resume_day','end_day','set_audio_input'))` ·
`args jsonb` · `status text NOT NULL DEFAULT 'pending' CHECK (pending|acked|failed|expired)` · `source text NOT NULL DEFAULT 'mcp'` · `result jsonb` · `error text` ·
`created_at timestamptz NOT NULL DEFAULT now()` · `acked_at timestamptz`. Index `(room_id, status, created_at)`.
Since R4-S fix-up D12, the `set_audio_input` applied fields go into `result`, not into new columns.

**bench_listener** (11 columns):
- From 0044:39–44: `room_id text PK → room(id)` · `tab_id text NOT NULL` · `last_poll_at timestamptz NOT NULL DEFAULT now()` · `recording_session_id text` · `paused boolean NOT NULL DEFAULT false`.
- From 0066:57–62: `mic_peak real` · `mic_avg real` · `spare_peak real` · `spare_avg real` · `levels_at timestamptz`.
- From 0068:38–39: `spare_device boolean`.

0069:51 and 0070:11 are data-only `UPDATE`s that clear the spare levels. The header of 0075 says no existing table is altered. 0071–0080 add nothing to either table.
The new poll fields land on **room_install** instead: 0077 `input_device_name` · 0078 `session_open, update_channel, last_update_{result,version,error,at}, disk_free_bytes` ·
0079 `assigned_channel (CHECK 'stable'), peak, zero_ratio, input_devices jsonb` · 0080 `input_volume real, input_volume_settable boolean`.

**What `pollCommands` sends today.** `BenchClient.swift:521–558`, `GET /api/bench/commands`:
- Always sent: `tab_id` (= `app_<install_id>`, `InstallPollFields.swift:197`) and `paused=true|false`.
- Sent when present: `prev_poll_at`, `recording_session_id`, and the `mic_peak` + `mic_avg` pair.
- Not sent: `spare_device`, `spare_peak`, `spare_avg`. The hardcoded `spare_device=false` was removed on 9 Sep (comment `:541–552`).
- Sent when enrolled (`install?.queryItems()`, `InstallPollFields.swift:199–252`). Empty strings are dropped (`:202`):
  - `install_id` · `app_version` · `build_sha` · `mic_state` · `tape_advancing` (always `true`/`false`) · `never_sleep` (when known).
  - `launched_by` · `hostname` · `hardware_model` · `os_version` · `input_device_name` · `session_open` (when known).
  - `update_channel` · `last_update_result` · `last_update_version` · `last_update_error` · `last_update_at` · `disk_free_bytes` (only when > 0).
  - B2: `peak` and `zero_ratio` (only in 0..1), `input_devices` (a JSON array).
  - R4: `input_volume` (only in 0..1), `input_volume_settable` (only when measured).

The server reads all of these, plus the three spare keys, at `app/api/bench/commands/route.ts:41–150`.
The poll response carries `assigned_channel` (B2, `BenchClient.swift:283`). Commands are read `pending`, oldest first, `LIMIT 20` (`bench-commands.ts:387–392`).

## 4. What B2-S, R4-S and R4-A added

**B2-S, fleet server half** (`a503da0`, plus fix-up `0b9757a`).
- Migration 0079 adds `room_install.assigned_channel` (CHECK `'stable'`), `peak`, `zero_ratio` and `input_devices`.
- New `POST /api/admin/installs/{installId}/assign-channel` ("Move to stable"). The fleet card is one row per room, shows disk levels, and leads with the self-update receipt's own failure sentence (the D4 fix in `room-install-view.ts`).
- Fix-up: `assigned_channel` comes back in the poll from `applyInstallPoll`'s `RETURNING` (no extra SELECT). It clears when the Mac itself reports `update_channel=stable`. Device name ≤128, uid ≤256.
- Gate: `Tests 1621 passed (1621)`. The Refuter accepted `0b9757a`. Flags: no `lock_timeout` on 0079; the SQL was checked by reading, not against live Postgres.
- 0079 applied 12:42:49Z. Promoted 12:47Z.
- Sources: `ETA-B2-S-BUILD-REPORT-11-SEP-2026.md`, `ETA-B2-S-REFUTER-VERDICT-11-SEP-2026.md`.

**R4-S, `set_audio_input` server half** (`6df15d7`, plus fix-up `9f11bbd`).
- Migration 0080 finds the old `kind` CHECK in the catalogue, replaces it with the five-kind CHECK, and adds `room_install.input_volume` and `input_volume_settable`.
- Adds the fifth kind with the strict validator. New `POST /api/admin/installs/{installId}/audio-input`: 200 `{command}` · 400 BAD_ARGS · 404 · 409 APP_TOO_OLD · 504 ACK_TIMEOUT. New MCP tool `scribe_set_audio_input` (scope `write`).
- Fix-up D11: refuse apps below 0.1.21 before any insert. Fix-up D12: the ack route keeps the three applied fields in `result`.
- Gate: `Tests 1678 passed (1678)`. The Refuter accepted `07dabbf..39463d8`.
- Open flag, carried to B3: D11 checks the bound install, but the bus delivers to whoever owns `bench_listener`. A browser tab ignores the row, the row never expires, and it holds a `LIMIT 20` slot for good.
- Sources: `ETA-R4-S-BUILD-REPORT-11-SEP-2026.md`, `ETA-R4-S-REFUTER-VERDICT-11-SEP-2026.md`.

**R4-A, Room Recorder 0.1.21** (`5af9075`).
- `BenchCommandKind` gains `.unknown(String)` (R4-D2): an unknown kind no longer fails the whole poll, and a command that can't be decoded is dropped on its own.
- `setAudioInput` validates first. It switches device by stopping the current `seg_` tapewriter and starting the next; the session stays the same and the gap is recorded.
- It sets input gain through CoreAudio `kAudioDevicePropertyVolumeScalar` (input scope), puts the previous device back on failure, writes the config atomically (0600), and acks the applied fields.
- The poll now reports `input_volume` and `input_volume_settable`.
- New failure reasons: `resident_archive_unsupported`, `device_switch_failed:…`, `volume_set_failed:…`, `config_write_failed:…`.
- Gate: `582 tests in 47 suites passed`. The Refuter accepted `5af9075`. Note: a device lost after a switch stays pinned in the config.
- Rollout: `test` at 15:17Z, `stable` at 15:27:56Z. OPD 3 and OPD 7 were switched to their C270s from the desk at 15:33–15:34Z.
- Sources: `ETA-R4-A-BUILD-REPORT-11-SEP-2026.md` (Rollout section), `ETA-R4-A-REFUTER-VERDICT-11-SEP-2026.md`.

## 5. Versions

`apps/room-recorder/Packaging/VERSION` = `0.1.21`. The latest migration is `db/migrations/0080_bench_command_set_audio_input.sql`.
Per `ETA-CARRYOVER-PROMPT-11-SEP-2026-EOD-R4-MASTER.md` §1 (fleet route and listeners, verified 15:36Z): production web is `5ff2ae0`, migrations are through 0080.
This session has no database or fleet access, so the table below is the carryover's claim, not re-verified.

| Room | App | Channel | Note |
|---|---|---|---|
| Home Office (Mini) | 0.1.21 | test | |
| Room 4.1 | 0.1.21 | test | |
| OPD 3 | 0.1.21 | stable | switched to C270 at 15:33:04Z |
| OPD 5 | 0.1.21 | stable | |
| OPD 6 | 0.1.21 | stable | |
| OPD 7 | 0.1.21 | stable | switched to C270 at 15:34:25Z |
| Cardiology | 0.1.20 | stable | Mac off since 14:13:06Z; takes 0.1.21 on its first check after power-on |
| OPD 1, OPD 4 | 0.1.8 | — | parked |

## 6. lib/mcp/** and lib/stt/**

- `lib/stt/**`: nothing changed. The diff is empty and no commit touches it. Confirmed.
- `lib/mcp/**`: **not nothing.** `lib/mcp/tools/bench.ts` +65/−0, in `6df15d7` and `9f11bbd` (R4-S). It adds `scribe_set_audio_input` (scope `write`) with the D11 version refusal. No other file under `lib/mcp/` changed.
- Carryover rule 34: the Cowork Scribe-MCP connector caches its tool list, so the tool stays invisible there until the connector is reconnected.
