# SPINE-PRELIVE-R3S-BUILD (branch spine/prelive-hardening, on 4b2bc169; new commit only, no rebase)
Builder: Sonnet. Fable ruling 12:45 IST 23 Oct: split B out.

## What changed
- B reverted: tools/eta-spine/executors.py restored from the merge base 3380cf9c (all B hunks were in this file: Terminated class, handler, `reaping` counter, `_reap`, sigmask/except restructure of `_run_group`; they came from 96c44347 and 79b923f6). `git diff origin/main -- tools/eta-spine/executors.py tools/eta-spine/runner.py` is EMPTY (byte-identical to main). runner.py was never touched by this branch, so A's pin (RUNNER_POLL_MS vs runner.py DEFAULT_POLL, tests/unit/spine-artefact-r4.test.ts) is unchanged.
- B tests removed: tools/eta-spine/tests/test_prelive_b.py (X4, R1 signal variants, B-1) moved with git mv to _to_delete/test_prelive_b.py (kept for the B lane). Main's own SIGTERM tests pass unchanged.
- KEPT: A, C, C-2, D, D-1, F, 0177 (commit 67aea26a/4b2bc169 untouched), C-1 report correction.
- F-4: tests/unit/spine-openbreakers-pg.test.ts `work()` now runs EXPLAIN in a transaction with SET LOCAL pins: no parallel workers and no bitmap scan always; index scans off for the OLD statement only (free, it walks spine_tick_at_idx backwards and stops after 20 matches, which is what made the control plan-dependent). The NEW statement keeps its index and is asserted on rows read: 87 <= 2000 (old 300,174, still asserted > 100,000, now deterministic).

## Tests
- openbreakers file, `--maxWorkers=4 --minWorkers=1`: 20/20 runs pass.
- D mutant (lib/spine/jobs.ts at 96c44347^, restored after): file FAILS ("expected 2 to be 4", the sentSql shape check in test 2). Killed.
- eta-spine pytest -n 4: "298 passed" (305 minus the 7 removed B tests).
- Gate (.bc/gate.log, one foreground run, 4 workers): typecheck 0, typecheck:tests 0, "Test Files  525 passed | 1 skipped (526)", "Tests  10434 passed | 7 skipped (10441)", 0 failed, build "Compiled successfully", check:silent "Found 9" (accepted pre-existing; gate=1 is that alone). swift N/A on Linux.

## Carry-over for the B lane
Re-do B on main's executors.py as its own lane. Must cover: Y5-Y9 and X4 as tests (X4 = a first Terminated swallowed in a finaliser/__del__, then a second TERM/INT must still kill; the old test is in _to_delete/test_prelive_b.py); 0 orphans over a 5,000-run storm; refute findings F-1, F-2, F-3 and F-5 (dead kill_children) from .bc/spine-prelive-r2-oref-REPORT.md. The reverted design (handler raises Terminated; kill/wait in _run_group's except path; `reaping` counter) is in commits 96c44347 and 79b923f6 for reference; it was NOT accepted.

## Assumptions / risks
- The unidentified pytest flake from R2 is unexplained; this run was clean once (298 passed), not re-looped.
- Append-only: no DELETE in any test. Linux; kiosk untouched.
