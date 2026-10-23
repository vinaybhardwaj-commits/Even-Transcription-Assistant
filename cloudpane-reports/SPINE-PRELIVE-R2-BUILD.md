# SPINE-PRELIVE-R2-BUILD (branch spine/prelive-hardening, on 5e1ccdc4; 0177 stays in its own commit 67aea26a)
Builder: Sonnet. Fix round for the R1 refute (.bc/spine-prelive-r1-oref-REPORT.md).

## What changed
- B-1 (79b923f6): tools/eta-spine/executors.py. The handler no longer keeps a "first signal wins" list; it ignores a signal only while `execs.reaping` > 0, a counter set by the new `_reap` around every `_kill_group` (timeout path, signal path, kill_children). At any other time it raises Terminated again, so a first Terminated swallowed in a finaliser cannot leave the runner deaf. New pytest in test_prelive_b.py (refuter's X4: `__del__` signals itself, then a second TERM / INT): old code fails 2/2 (rc stays alive, "deaf-to-second"), new exits 143 / 130.
- C-2: lib/room-access/readers/spine-artefacts.ts nemotronPageSql. The blind OR-EXISTS over room_day is split into three EXISTS (own day by pk; bench_window JOIN room_day; room_diarize_window JOIN room_day). Planner now hashes each once per page instead of seq-scanning room_day per page row. Same rows (equality test unchanged: 3 fixtures x 3 blind sets x 4 cursors, md5). Plan-work guard now scales with the page: bound = 20*PAGE + 2*n + 8*days; tested at 5k rows/1000 days, 20k/1000, 5k/5000 days. Measured plan rows: fixed 17,002 / 32,002 / 33,000; old statement 1,624,500 / 1,677,000 / 8,028,500 (old is now flagged by the guard); table-wide control 4.0M / 16.2M / 20.0M.
- D-1: tests/unit/spine-openbreakers-pg.test.ts (own commit 40b74385): verdict equality with the old statement on 11 histories and the bounded read, on the schema WITHOUT 0177 (file never reads it). The EXPLAIN/index/rollback test stays in spine-tick-breaker-pg.test.ts with 0177.
- C-1: R1 report line corrected (C inner-LIMIT mutant SURVIVES; fence unobservable on PG16).

## Tests
.bc/gate.log (one full gate, 4 workers, foreground): typecheck 0, typecheck:tests 0, vitest "Test Files  525 passed | 1 skipped (526)", "Tests  10434 passed | 7 skipped (10441)" (0 failed), build "Compiled successfully", check:silent "Found 9" (the accepted pre-existing set; it exits 1, so gate=1 is that alone). 0 new failures.
eta-spine pytest (-n 4): 1 failed, 304 passed in 13.07s. Targeted: spine-nemotron-page-pg 2/2, spine-openbreakers-pg 2/2. swift: N/A on Linux.

## Assumptions / risks
- D-1: the D code commit 96c44347 cannot be amended (no rebase); its test is the next commit, so a cherry-pick of D alone needs 40b74385 with it.
- The pk scan + top-N sort reads the whole nemotron table once per page (computed lpad pk); inherent and unchanged, so the guard allows 2*n for it.
- Append-only: no DELETE used in any new test. Linux, swift N/A; kiosk untouched.
