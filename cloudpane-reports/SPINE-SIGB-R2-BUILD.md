# SPINE-SIGB-R2-BUILD: signal handling redesigned as record-only while a child runs (branch spine/sigb-signals, on a0e9d486)
Source: Opus refute R1 (F-A, F-B, F-C, F-D). No TS touched. Host asus, Linux, Python 3.14.

## What changed
- `tools/eta-spine/executors.py`: the state machine is gone. `on_signal` records (first signum kept, `signals_seen` counts), and raises SystemExit(128+first) ONLY when no child is registered. While a child is registered it never raises.
- `_run_group` polls `communicate(timeout=min(0.5, remaining))`. Between slices it checks the recorded stop: kill the group once, reap, break. Timeout (remaining <= 0): one kill + reap (F-3), break. After the child is unregistered, `_raise_pending()` raises anything recorded (also during a timeout reap, F-2), else TimeoutExpired / the result. State is only RUNNING/REAPING (`reaping` kept).
- Idle swallowed raise (no child) is still forgotten at `_run_group` entry (Y1/X4: first-signal-wins not reintroduced). A stop recorded WITH a child registered is never lost (F-B).
- `tests/test_signals_oref.py`: the refuter's O1-O8 adopted, assertions unchanged. Only edits: PKG path made repo-relative, FINDING_ dropped from two names, and O7 (print only) now asserts the INFO change (below).

## Results
- eta-spine pytest `-n 4` x3: **335 passed** each (was 320; +15 O-tests).
- F-A: refuter's unwidened +-6 ms timeout harness, 5,000 runs (4 x 1,250): **0 orphans, 0 hangs, 0 bad rc** (all 143). A first attempt had 3 runs with rc 0 (a signal recorded between `_raise_pending` and the child's unregister was lost). Fixed by moving the raise after the unregister; the rerun is the 0/5,000.
- TERM+INT+TERM storm (0-30 ms), 5,200 runs: **0 orphans, 0 hangs, 0 bad rc**. All rc 130: CPython runs coalesced pending signals lowest signum first, so SIGINT is the "first" one seen. Not a defect.
- F-C: stop latency (SIGTERM at a random 0-600 ms with a child running), 600 runs: median 0.365 s, p99 0.566 s, **max 0.567 s** (target <= 1 s).
- Gate (.bc/gate.log, 4 workers, one foreground suite): typecheck + typecheck:tests OK; vitest "Test Files 521 passed | 1 skipped (523)", "Tests 10423 passed | 7 skipped (10435)", **0 failed**, "Errors 2 errors" (`Timeout calling "onTaskUpdate"`, the load flake seen at R1), gate=1 from that. build=0 and check:silent "Found 9" (accepted set) were run separately. swift: N/A on Linux. 0 TS diff, so 0 new failures.

## F-D (R1 report counts, corrected)
Main has 298 tests and a0e9d486 had 320 (+22), not "305 + 15". main's handler did call `kill_children`; F-5 removal is by design. Now 335.

## INFO (kept, documented)
Without `--live` (no handlers), Ctrl-C or any exception out of communicate kills the child group (main left it running). O7 asserts it.

## Assumptions
- Worst-case stop latency is bounded by POLL_S (0.5 s) plus the kill; not measured under heavy load.
- A finished child whose result arrives with a recorded stop exits 143/130 instead of returning the result (the job's report is not posted; the lease re-offers it).

## Open risks
- Mutants not rerun this round. The vitest RPC timeout flake is unresolved (pre-existing, long pg files).
