# SPINE-S5-R2-BUILD — fix round R2 on spine/s5-queue (base bb7c315e + merge of origin/spine/s0-schema 46134366)
## Changed
- F1 app/api/spine/claim/route.ts: non-live claim takes ONLY shadow-mode stages (live=true takes only live).
- F2 lib/spine/{retry,jobs}.ts: breaker = plan §4 on ATTEMPT outcomes (>=30% of last 20, transient included, no sample floor, open 30 min). Bookkeeping: one spine_tick row kind `attempt:<stage>` counts {failed:0|1}, written in the SAME statement as the owner-matched report UPDATE (CTE), so a lost lease records nothing; reaper deaths record a failure. budget/shadow/release record nothing. 0173 unchanged.
- F3 jobs.ts + lib/alerts/ops-alert.ts: dead alert room_id = spine-<stage>, dedupe window 6 h via new optional `dedupe_minutes` (default 60, other callers untouched). dead_alert stays default off.
- F4 config.ts: kill_switch killed unless exactly false / {on:false} (absent row = not a kill; jobs still defaults off).
- F5 tools/eta-spine/runner.py: owner host:pid:token per process; report retried once (not on 409) then logged; bad SPINE_POLL_SECONDS (non-number, <=0, nan, inf) -> 60 with one stderr line.
- enqueue sets status 'queued' (S0 R2 removed the default).
- Tests: refute's race, concurrent-claimer, reaper, route-on-pg and runner tests ported into tests/unit/spine-queue-pg.test.ts and tools/eta-spine/tests/test_runner.py; new F1-F5 tests.
## Tests (own runs)
- spine vitest (queue, queue-pg, schema-pg): all pass; pytest tools/eta-spine: `16 passed`.
- Full gate (.bc/gate.log, 4 workers): `Test Files  2 failed | 451 passed | 1 skipped (454)`, `Tests  2 failed | 9374 passed | 5 skipped (9381)`. The 2 failures (e11-silent-room-window, no-identity-literals) are the pre-existing ones from the S5 refute (also fail at base e9f7e6a2; no spine path in their output). Because they stop the && chain, typecheck + typecheck:tests passed, then build (`build=0`) and check:silent (`Found 9`, 0 in spine; accepted baseline) were run separately.
- swift build/test: N/A on Linux.
## Mutants (/tmp/spine-s5-r2-mut)
- 33 run (18 refute + 15 new). KILLED: 31. SURVIVED: M6, M8 (documented equivalents: UPDATE also compares attempts, which every claim increments).
- New, all killed: non-live claims live stage; breaker ignores transient; dedupe without stage; malformed kill passes; 5-sample floor back; dedupe 6h->1h; open 30->10 min; ratio 0.3->0.5; window 20->100 (needed an added test); tick written on lost lease; enqueue without status; owner bare hostname; no report retry; retry on 409; poll crash. M5 anchor needed fixing, then killed. M7 now killed by the builder suite (race test).
## Assumptions
- Breaker data lives in spine_tick (existing table, kind `attempt:<stage>`); no retention/pruning of those rows is built (S-later).
- SPINE_RUNNER_OWNER, if set, replaces only the hostname part.
## Open risks
- F3: kind stays heal_escalated (the only kind the outbox CHECK allows); the Mini relay will present it as a room heal escalation for a "room" spine-<stage>. Relay handling of a non-room is UNVERIFIED.
- Breaker reads spine_tick per stage per claim (20-row indexed-by-time scan, kind unindexed besides spine_tick_at_idx); fine at shadow volume, revisit before live.
