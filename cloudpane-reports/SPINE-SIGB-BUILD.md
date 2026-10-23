# SPINE-SIGB-BUILD — eta-spine runner signal state machine (lane spine-sigb, branch spine/sigb-signals off origin/main 8b185887)
## Changed
- tools/eta-spine/executors.py: ONE explicit machine on `Executors` (RUNNING -> STOPPING -> REAPING -> EXIT, documented in a comment block). `install_signal_handlers` now only calls `Executors.on_signal`, which records the signal (the first fixes the exit code) and raises SystemExit(128+sig) at most once per stop; it never kills or waits.
  - Raises when RUNNING / EXIT, or STOPPING with no child registered (a swallowed raise, X4). Records only while REAPING, or STOPPING with a child registered (the except path is about to kill it): F-1 closed.
  - `_run_group`: one outer try covers spawn-unmask + communicate; `_reap` (one killpg+reap, REAPING for its duration) runs once per exit path. Timeout: reap once, then `_raise_pending` (F-2: a first signal during a timeout reap exits 143 when the reap returns; F-3: one kill).
  - A stop whose raise was swallowed is forgotten at the next `_run_group` entry (state back to RUNNING), so the next signal still kills and exits.
  - F-5: `kill_children` was dead (never called) -> REMOVED. `reaping` kept as a read-only property (Y7 asserts it).
- tests: tests/test_signals.py (Y5-Y9 + X4, assertions unchanged except Y8 now asserts rc 143 unconditionally instead of behind env Y8_RC), tests/test_signals_y.py (Y1-Y4), tests/test_signals_x.py (X1-X3), ported with paths made relative.
## Verification (own runs, /tmp/spine-sigb-venv)
- eta-spine pytest `-n 4` x3: "320 passed" each (main's 305 + 15 new). One earlier run showed 1 failure while 4 import errors were also present (my porting typo); not reproduced afterwards (3 clean runs, plus a 30-test run). Cause of that one failure UNVERIFIED.
- Y6 storm: 4 x 1,300 = 5,200 runs (TERM+INT+TERM back-to-back, child+grandchild): "Y6 bad 0 of 1300" x4 => 0 orphans, 0 hangs, 0 wrong rc. (R2 branch: 4/5,060.)
- Mutants, all killed: (a) handler raises while STOPPING-with-child dropped -> Y5 x2 fail; (b) `_raise_pending` removed -> Y8 fails; (c) `except BaseException` narrowed to Exception -> 3 fail (Y6 among them).
- Gate (.bc/gate.log, asus, foreground, --maxWorkers=4 --minWorkers=1): typecheck + typecheck:tests OK; vitest "Test Files 521 passed | 1 skipped (523)", "Tests 10393 passed | 7 skipped (10435)", BUT "Errors 2 errors" (vitest-worker "Timeout calling onTaskUpdate", RPC timeout under load; Duration 1921s) so the runner exited 1 and `&&` skipped build/check:silent. 0 test failures. This branch changes no TS; I did not investigate the RPC timeout (UNVERIFIED cause, likely host load). Then ran separately: `npm run build` build=0; `npm run check:silent` "Found 9" (the accepted set). swift: N/A on Linux. Migrations: none.
## Assumptions
- Y8's env gate removed so F-2 is enforced always. The Exit code on a swallowed-then-new-signal is the NEW signal's code (the swallowed one is forgotten at next spawn).
## Open risks
- A first raise swallowed by a finaliser while a child is already running (registered) leaves STOPPING+child: later signals are recorded but not raised until the child ends. Not covered by any test (X4/Y1 cover the no-child and next-spawn cases). Under systemd the cgroup kill backstops it.
- Full-gate exit 1 above is a vitest worker-RPC error, not a test failure; Orchestrator to rule.
