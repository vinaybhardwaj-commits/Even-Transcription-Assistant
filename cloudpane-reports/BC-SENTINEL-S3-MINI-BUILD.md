# BC-SENTINEL-S3-MINI-BUILD (lane bc-s3m, branch bc/sentinel-s3-mini)

## What changed
- `tools/room-guardian/mini/subscriber/consult_hold.py`: `_room_live()` (true only on every-machine-fresh heartbeat AND newest POST-driven event an open within OPEN_UNCLOSED_MAX_S; false on a close; otherwise ABSENT), `compute()` fills `self._live` from the same presence read and wipes it to {} on ANY source error, new `live()` (synchronous or reads the background refresher's snapshot; stale/missing snapshot = {}), refresher stores `_snap_live`.
- `tools/room-guardian/mini/subscriber/subscriber.py`: `CONTROL_RE_V3` (form 3, sort_keys: consult_live, consult_open, kill, modes, ts), `canonical_control()` picks form by maps present, `validate_rooms(consult_live=)` counts both maps, `Subscriber(consult_live=)` adds the map in `control_snapshot()` only with the hold built.
- `tools/room-guardian/mini/subscriber/run_subscriber.py`: `check_rooms` counts form 3; `build_subscriber` passes the flag.
- `tools/room-guardian/mini/router/ubus_bus.py`: `consult_live_publish` in `load_cfg`, literal-true-only, default false.
- `tools/room-guardian/mini/tests/test_consult_live.py`: 23 new tests (stale hb absent, fresh open true, fresh close false, open > 4 h absent, DB error whole-map absent + consult_open fail-closed unchanged, flag-off golden bytes, flag-on form 3 sort_keys, background snapshot, budget, end-to-end wiring).
Nothing in kiosk/, nothing in TypeScript, no config file changed (flags live in Mini-only router.json).

## Tests (exact summary lines)
- Full mini suite at base (bffc52f7, temp worktree): `Ran 402 tests in 46.589s` / `OK (skipped=15)`.
- Full mini suite on branch (`tests/run.sh`, shellcheck + unittest): `Ran 425 tests in 51.320s` / `OK (skipped=15)`, exit 0. New tests = 23, no new failures, no new skips.
- New file alone: `Ran 23 tests in 0.034s` / `OK`.
- Mutant (stale room reports false instead of absent, one line in `_room_live`): `Ran 23 tests in 0.032s` / `FAILED (failures=2)` — killed by test_a_stale_heartbeat_is_absent_not_false and test_a_multi_machine_room...; reverted.
- TS/swift/kiosk gates: not run — no TS, Swift or kiosk files touched (scope rule).

## Assumptions
- Brief's base count (40 tests, 7 skipped) is stale for origin/main; measured base is 402/15. "No new failures vs base" holds.
- "fresh encounter_close" = the newest POST-driven event within the hold's existing 4 h read window (ENC_LOOKBACK_S); a close older than that leaves no POST event, so the room is ABSENT, not false.
- Multi-machine rooms: ALL mapped machines need a fresh heartbeat (as the hold); the newest POST row across machines decides.
- "Any DB error" = any of the four hold sources (presence, session, levels, windows) erroring or stale takes the WHOLE map away.

## Open risks
- Release order: the kiosk form-3 parser must ship FIRST; consult_live_publish stays default false until then (it is).
- Prod consult_room_map coverage is UNVERIFIED (plan G1); unmapped rooms stay absent.
- The S3 bench (1 clinic day consult_live vs scribe_now per room) needs the Mini; not done in this lane.
