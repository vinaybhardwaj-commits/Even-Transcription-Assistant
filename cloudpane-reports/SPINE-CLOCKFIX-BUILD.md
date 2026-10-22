# SPINE-CLOCKFIX-BUILD (lane spine-clockfix, branch spine/clockfix-tests, test-only)

## Changed
- tests/unit/spine-queue.test.ts: the claim-route test now pins Date to :10 IST (vi.useFakeTimers toFake Date); NEW test asserts that inside :20/:30/:44 IST a live claim withholds K lanes (acoustics, nemotron) and still hands out a non-K stage (parts), and that :10 restores them.
- tests/unit/spine-s6-pg.test.ts: "claim route returns consult_uid only for live=true" pinned to :10 IST; NEW pg test asserts that at :30 IST a live claim skips the queued acoustics job (stays queued) and claims a recut job.
- No production code changed.

## Method
Clock-shift harness (untracked, .bc/vitest.clock.config.ts + a setup file shifting Date to a chosen IST minute, clock still ticking) over tests/unit/spine-*.test.ts and spine-oref-r2/.
Before the fix, :10 -> 499 passed; :30 -> 2 failed (spine-queue claim test; spine-s6-pg consult_uid test). Those are the only clock-dependent spine vitest tests.
tools/eta-spine pytest: only elapsed-time use of time.time(), no wall-clock dependence; 298 passed.

## Verify (after fix, spine suites at fake IST minute)
:10, :20, :22, :25, :30, :44, :50 -> each "Test Files 41 passed (41) / Tests 501 passed (501)".

## Gate (.bc/gate.log, ONE run, --maxWorkers=4; typecheck, typecheck:tests, vitest, build, check:silent chained)
"Tests  2 failed | 10232 passed | 7 skipped (10241)", gate=1. Failures: no-identity-literals (tools/eta-consult-steward/tests/conftest.py etc., no spine file) and e11-silent-room-window sweep. Neither touches spine; spine-queue passes. I take these to be the B29/B30 the brief expected, but I did not run the base to confirm: UNVERIFIED mapping. Build/check:silent did not run (chain stops at vitest failure): UNPROVEN.
swift build/test: N/A on Linux.

## Assumptions / risks
- Pinned time is computed from Date.now() forward to the next :10/:30 IST, so job rows created with real time stay visible.
- Any new spine test that claims K lanes through the route must pin the clock the same way.
