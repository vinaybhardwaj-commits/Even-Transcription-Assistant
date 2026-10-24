# SPINE-SIGB-R3-BUILD (branch spine/sigb-signals, on d39d7fac; no TS touched)
Changes
- tools/eta-spine/executors.py: F-E dropped `and p.poll() is None` in the `except BaseException` reap (non-live Ctrl-C now kills the group after the direct child exits).
  F-B': removed the entry reset of `stop_signum` in `_run_group` (a swallowed idle stop is never forgotten); `_raise_pending` renamed public `raise_pending`.
- tools/eta-spine/runner.py: the loop calls `execs.raise_pending()` before each claim, so a recorded stop exits 128+signum without claiming.
- tests: refuter P1-P11 adopted as tests/test_signals_oref_r2.py (same assertions, PKG = repo copy). test_runner.py: new r3 loop test.
- test_signals_y.py Y1 CHANGED (it encoded the old semantics: swallowed stop forgotten, needs a 2nd signal). New Y1: the kept stop kills the next child at its first poll, exit 143/130, no 2nd signal, no orphan.
Tests (Linux, /tmp/spine-sigb-venv, -n 4, x3): `351 passed in 54.29s` / `351 passed in 54.40s` / `351 passed in 49.65s` (P8 included).
Harness (refuter's unwidened tgap harness, copies in .bc/r3h; only edits: drv calls ex.raise_pending() after its idle sleep, as the runner loop does, sleep 3 s -> 0.6 s, 12 workers):
- tgap 5000: `rc {"143": 5000}`, orphan_runs 0, hangs 0, raised_with_child 0, over1s 0 (R2: 7/5000 rc 0).
- storm 600: orphans 0, hangs 0, raised_with_child 0, lat_max 0.576 s (rc -2/-15 in 71 = pre-existing interpreter-finalisation exit, same as R2 report).
- lat 600: all 143, max 0.568 s. idle 300: all 143, max 0.065 s. fc 300: 0 hangs, 1 orphan (the known INFO: signal to a non-main thread in Popen-before-register; no threads in eta-spine).
Assumptions: raise_pending in the loop is a no-op without --live (no handlers, stop_signum None). The harness driver stands in for the runner loop, which is why it was edited.
Open risks: Y1 semantic change needs Orchestrator sight. swift/build N/A (no TS touched, not run). Mutants not re-run.
