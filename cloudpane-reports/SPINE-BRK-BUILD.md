# SPINE-BRK-BUILD — data-driven recut skips must not trip the stage breaker
Branch spine/brk-data-skips (off origin/main with #211). Builder: Sonnet, c3.

## Changed
- lib/spine/data-skips.ts (new): exported `DATA_DRIVEN_CODES` + `isDataDrivenCode`, documented. Codes: silent_audio, blind_room_day (permanent, bare), skip_no_session, skip_no_tape_unexplained (+ `skip_no_tape_unexplained_<state>_` prefix, the runner's _token form of `no_tape_unexplained(<state>)`), skip_device_missing, skip_power, skip_recut_coverage_lower.
- app/api/spine/report/route.ts: passes `noBreakerTick` to reportJob for a transient/permanent report with a data-driven code. reportJob, BREAKER_*, claim ordering, runner, spine_config untouched.
- tests/unit/spine-brk.test.ts (new): 10 tests: 1 required-proof gate, 3 pure, 6 on postgres:16 through the real claim + report routes.

## Tests
- tsc --noEmit: exit 0.
- vitest tests/unit/spine-brk.test.ts: `Tests  10 passed (10)`.
- Covered: 10 skip_no_session leave breaker closed, 0 ticks, next claim is fresh job r10; 10 rc_1 open it (as before); mixed 5 rc_1+10 skip+12 done = 17 ticks, closed (would be open if skips counted); mixed 5+10+5 = 10 ticks, open; permanent silent_audio/blind_room_day no tick, unknown skip_* ticks; attempts/backoff/class identical for skip vs rc_1, job dies at MAX_ATTEMPTS; scan of cutter run.py + state.py skip reasons pinned against the list (fails on a new, unlisted reason).
- Mutant: route with noBreakerTick forced off -> 5 of 10 failed (killed). Restored.
- vitest tests/unit/spine --minWorkers=1 --maxWorkers=4 (foreground-equivalent, one at a time): `Test Files  73 passed (73)`, `Tests  878 passed (878)`, exit=0. tsc exit 0. Full gate (build, check:silent) not run; swift N/A on Linux.

## Assumptions
- `skip_unknown` (unparsed reason), `not_selected` tick (fail safe). `skip_recut_coverage_lower` counted as data (rotated tape = a fact about the data).
- Test uses run-time `new Date()` in the real routes; backoff bound check is 0 < wait <= 2 h.

## For fable
- lock_busy and gpu_busy left unchanged (still tick): both are contention and could trip the breaker the same way if they pile up.
- Existing failed ticks already in spine_tick age out of the 30 min window by themselves; nothing migrated.
- Open risk: a cutter reason added later is caught by the pin test only if it uses the `skip_reason="..."` / f"... " shapes the scan reads.
