# ETA TIER 1 BUILD REPORT — named states + three verbs — 11 Sep 2026

**Commits** on `vinay/tier1-states`, from `d4821ec`. Not pushed. `main` not touched.
`7b3f21f` Slice A: named install states (0081, server only) · `5bc415d` Slice B server · `b32772f` Slice B app (room-recorder).

**Gate** (every line was run before each commit; the numbers below are the final tree's):
- `npx tsc --noEmit` exit 0. `npm test`: `Tests 1759 passed (1759)`, 78 files. Baseline was `1678 passed`, 74 files; after Slice A, `1726 passed`.
- `npm run build` exit 0. `npm run check:silent`: the 9 accepted findings, identical to baseline (diffed).
- `swift build`: Build complete. `swift test` (CLT plugin flags): `Test run with 600 tests in 48 suites passed`. Baseline was `582 tests in 47 suites`. No `needsEnrolment`.
- The order said `pnpm`. pnpm is not installed and there is no lockfile, so I ran `npm test` (= `vitest run`) and `npx tsc --noEmit`.
- Bare `swift test` fails here: TestingMacros is not found. I used the flags from the 0.1.8 console runbook (`-plugin-path …/plugins/testing` plus two rpaths). The bare baseline passed only on a cached build.

**Files** (`git diff --stat d4821ec..HEAD`): 27 files, +3612/−108. All are in §1, or are tests, or the kickoff (committed with Slice A under the repo rule).
No `lib/stt` change. The only `lib/mcp` change is `scribe_room_command`: its tool, its BENCH_TOOLS entry and five imports.
`LISTENER_FRESH_MS` and `ACK_WAIT_MS` are unchanged; a test pins both. No release was published and 0081 was not run anywhere.
Existing tests changed because the spec changes their behaviour: `room-install-b2`, `room-install-assign-route`, `room-install-reason-route` (the fake interpreter learned the column-compare CASE), `bench-commands-set-audio-input`, `bench-orphan`, and `RoomSelfUpdateTests.swift` (two B2 channel tests narrowed).
New tests: `bench-room-states` (47), `bench-commands-new-kinds` (18), `mcp-room-command` (9), `room-install-assign-test-channel` (6), `RoomOperatorVerbTests` (18).

**SQL (all INFERRED; no live database):**
- 0081 file: seven `ADD COLUMN IF NOT EXISTS` (state_flags jsonb, state_changed_at timestamptz, poll_ring jsonb, expected_device_name text, clip_count integer, silence_ms bigint, channel_locked boolean).
- 0081 file: two catalogue DO blocks, 0080's method. They drop the one CHECK on `bench_command.kind` and add `bench_command_kind_check` with 8 kinds; they drop the one CHECK on `room_install.assigned_channel` (0079 wrote it inline) and add `room_install_assigned_channel_check IN ('stable','test')`.
- The poll UPDATE gains: `clip_count = COALESCE(?::integer, clip_count)`, `silence_ms = COALESCE(?::bigint, silence_ms)`, `channel_locked = COALESCE(?::boolean, channel_locked)`, `assigned_channel = CASE WHEN ?::text = assigned_channel THEN NULL ELSE assigned_channel END`, `expected_device_name = COALESCE(expected_device_name, ?::text, input_device_name)`.
- The poll UPDATE also gains `poll_ring = (SELECT COALESCE(jsonb_agg(r.e ORDER BY r.n), '[]'::jsonb) FROM jsonb_array_elements(jsonb_build_array(?::jsonb || jsonb_build_object('silent_polls', CASE WHEN ?::boolean THEN COALESCE((room_install.poll_ring -> 0 ->> 'silent_polls')::int, 0) + 1 ELSE 0 END)) || CASE WHEN jsonb_typeof(room_install.poll_ring) = 'array' THEN room_install.poll_ring ELSE '[]'::jsonb END) WITH ORDINALITY AS r(e, n) WHERE r.n <= ?::int)`, and it now ends `RETURNING install_id, assigned_channel, poll_ring, state_flags, input_device_name, input_devices, expected_device_name, disk_free_bytes, update_channel`.
- The state write, run only on a change or the first evaluation: `UPDATE room_install SET state_flags = ?::jsonb, state_changed_at = CASE WHEN ?::boolean THEN now() ELSE state_changed_at END WHERE install_id = ? AND retired_at IS NULL`.
- On a `set_audio_input` ack: `UPDATE room_install SET expected_device_name = (SELECT d ->> 'name' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(input_devices) = 'array' THEN input_devices ELSE '[]'::jsonb END) AS d WHERE d ->> 'uid' = ? LIMIT 1) WHERE room_id = ? AND enrolled_at IS NOT NULL AND retired_at IS NULL`. The ack UPDATE now ends `RETURNING id, kind`.
- The fleet SELECT adds `state_flags, state_changed_at, expected_device_name, channel_locked`. The assign UPDATE is unchanged but may now write `'test'`.

**Seams I interpreted differently from the spec**
1. **`scribe_diff_room` does not show `room_state.flags[]`.** `room_state` is built inside `diffRoom` in `lib/mcp/tools/bench.ts`, and the order allows one MCP tool only. The flags are on the `/api/admin/bench/fleet` row (`install.state_flags`) and on the card. Acceptance item 1 as written needs an order for about six lines in `diffRoom`.
2. **All of Tier 1's DDL is in 0081, committed with Slice A,** including Slice B's two CHECKs and three columns. The runner never re-runs a version, so a database that took Slice A would otherwise never get Slice B's DDL.
3. **`state_flags` is an object `{flags[], drift_since}`, not a bare array.** CHANNEL_DRIFT needs a clock. The flags are written by a second, best-effort statement, and only when they change. Most polls stay at one statement.
4. **The ring is 10 entries, but SILENT needs 80 polls.** Each ring head carries `silent_polls`, the run length, in SQL. Ring entries also carry `rec`, plus `clip_count` and `silence_ms` from a 0.1.22 app.
5. **"Recording" means a session id was reported and the room is not paused.** ENCODER_STALLED needs all 4 polls to be recording, and CLIPPING counts only recording polls. Without this, every session start would read as a stall.
6. **With `silence_ms` present, SILENT fires at ≥ 80 × 1.5 s = 120000 ms.** With `clip_count` present, a poll counts as clipped when `clip_count > 0`, and `peak` is ignored for that poll. A 0.1.21 poll falls back to `zero_ratio ≥ 0.98` and `peak ≥ 0.99`.
7. **`expected_device_name`.** While it is NULL (enrol, or any row older than 0081), the poll adopts the name it reports. A `set_audio_input` ack sets it from `input_devices` by uid; if the uid isn't listed it sets NULL, and the next poll adopts.
8. **CHANNEL_DRIFT still fires on a `channel_locked` Mac.** The drift is real; the card shows the lock beside it. This needs a ruling.
9. **The assignment now clears when the Mac reports the assigned channel, not only `stable`.** Under B2's literal rule, a stable Mac's first poll would clear a `test` assignment before the Mac could act on it.
10. **`restart_engine` exits 75, not `exit(0)`.** The LaunchAgent is `KeepAlive: {SuccessfulExit: false}`, so exit 0 means "stay stopped". The exit goes through an injected `processExit`, because the CLI's exhaustive switch is in `main.swift`, outside the contract. Before exiting, the app stops the capture without ending the session. If the ack never lands, the app does not restart; otherwise a redelivered command would loop restarts.
11. **`check_update_now` acks from a hook inside `RoomUpdater.check`, before the download.** The swap script boots the app out at once, so a later ack would die in flight. The result may add `held:true`. An unbundled build answers `update_unavailable`. Args must be null; `{}` is refused.
12. **`clip_count` and `silence_ms` are measured in `RoomEngine`, from the durable PCM up to the index's `samples`,** because tapewriter and TapeCore are outside the contract. Full scale means ±32767/−32768; −55 dBFS means |x| ≥ 59. A read covers at most 30 s, so silence can be understated but never overstated.
13. **`report_diag` details.**
    - tapewriter has no `--version`, and `TapewriterCLI` is outside the contract, so the report records its "unknown command … (exit 1)" line. ffmpeg is asked with `-version`.
    - The log is `launchd.log`. Lines naming the four Refuter words, or `authorization` or `cookie`, become `[redacted]`.
    - The server withholds (does not store) any payload that still contains the four words, and caps it at 256 KB.
14. **`scribe_room_command` accepts the 3 verbs only and has its own wait.** `sendAndWait` hard-codes 8 s. The admin route queues and returns `ack_wait_ms`, without waiting, the same way pause/resume/end do.
15. **Card scope was chips only.** Two stale strings remain: "assigned stable · waiting for the Mac" and the Move-to-stable tooltip "The server never moves a Mac onto test". The browser kiosk's `CommandKind` union (`lib/use-command-poll.ts`, not in scope) doesn't list the new kinds; it ignores them without acking, as it does `set_audio_input`.
16. **`Packaging/VERSION` and `CHANGELOG.md` are not in §1 and are not bumped.** A 0.1.22 bundle needs both before the floor can pass. The listener's `mic_peak`/`mic_avg`, listed as inputs, are unused.
17. **Bus files.** The kickoff is committed (repo rule). This report and `ETA-DELTA-…md` are uncommitted. The memory and carryover files were not touched.

**V's manual steps.**
- Apply 0081 to the preview before promoting, the way 0079 was applied: `curl -X POST -H "Authorization: Bearer $MIGRATION_SECRET" https://<preview-host>/api/run-migrations`.
- Order the VERSION/CHANGELOG bump for 0.1.22.
- Rule on seams 1 and 8.

**Subagents:** none.


## Fix-up — 12 Sep 2026, on the four rulings

**Commits** on `vinay/tier1-states` from `b32772f`, one per ruling; not pushed, `main` untouched: `92b4fde` seam 1 · `b0cb060` seam 8 · `40ab2bd` seam 16 · `b86072b` seam 15.
**Gate.** `npx tsc --noEmit` exit 0. `npm test`: `Tests 1772 passed (1772)`, 79 files (was 1759 in 78). `npm run build` exit 0. `npm run check:silent`: the same 9 accepted findings, none in a changed file. `swift build`: Build complete. `swift test` (runbook flags): `Test run with 600 tests in 48 suites passed`, no `needsEnrolment`.
**Swift flake, NOT mine.** Seven full runs; two failed on `failedRolloverIsRefusedWithoutRetryingEffects` (`RetainedArchiveRecoveryTests.swift:145`, `.keywrapMismatch`) — 6/6 green under `--filter`, so it is a parallel-run race. This fix-up changes no Swift source, and nothing under `Sources/` or `Tests/` reads `Packaging/VERSION` or `CHANGELOG.md` (grep empty).
**Files** (`git diff --stat b32772f..HEAD`): 9 files, +280/−21. Nothing outside the four rulings moved. 0081 unchanged, not run anywhere; nothing published.
**New tests: +13.** `mcp-diff-room-install-states` (7, new file), `bench-room-states` 47 → 52, `room-install-assign-test-channel` 6 → 7.
**SQL (INFERRED; no live database).** One new statement, in `diffRoom`, one per room per call: `SELECT state_flags FROM room_install WHERE room_id = ? AND enrolled_at IS NOT NULL AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`. The poll UPDATE's `RETURNING` gains `channel_locked`; otherwise every SQL string above stands.
**What each ruling became.** Seam 1 — `room_state` gains `flags` and `drift_since`; `flags` is NULL, never `[]`, for no bound Mac / never evaluated / failed read, and a failed read also names itself in `degraded`. The tool description gained one appended sentence and is otherwise byte-identical. Seam 8 — `evaluateInstallStates` takes `channelLocked`, and a lock makes `drifting` false, so `drift_since` is not started either: unlocking gives the Mac the full 30 minutes instead of firing on the next poll. The lock silences CHANNEL_DRIFT and nothing else. Seam 16 — `0.1.22` in both files. Seam 15 — strings only.
**Flags.**
1. **Seam 15 was done as strings, not logic.** `assigned_pending` is still `assigned_channel === 'stable' && update_channel !== 'stable'`, and `can_move_to_stable` still requires `update_channel === 'test'`. A pending **test** assignment therefore renders no line at all, and the neutral wording is neutral over a stable-only condition. Making those two channel-neutral is about one line in `room-install-view.ts`; the ruling did not order it, so it needs one.
2. Seam 1 adds one SELECT per room to the all-rooms sweep — six extra reads per call at today's six rooms.
3. This report and `ETA-DELTA-…md` are still uncommitted; the memory and carryover files were not touched.

**V's manual steps:** unchanged — 0081 on the preview before promoting. Nothing new. **Subagents:** none.
