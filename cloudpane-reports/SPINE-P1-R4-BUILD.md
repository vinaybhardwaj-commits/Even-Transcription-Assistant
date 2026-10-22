# SPINE-P1 R4 build (spine/p1-producers, on ee9f33e4)
Fix F4 (R3 refute): on an acoustic-due tick the room-day list is rotated by the HOUR index (floor(now / 3_600_000) mod n); leave (not-due ticks) keeps the tick rotation.
## Changed
- lib/spine/producers.ts: `rotateByTick(list, nowMs, periodMs = TICK_MS)`, `HOUR_MS`, runProducers passes `due ? HOUR_MS : TICK_MS`.
- tests/unit/spine-p1-r3.test.ts: two hour-period rotateByTick assertions.
- tests/unit/spine-p1-r3-oref-adv.test.ts: the refute's R3 file ported; its PROVEN-starvation block replaced by the model test (every room-day gets acoustic within n-b+1 hours, n 1..16, b 1..4, via the real runProducers) plus the old starving cases n=4 b=1, n=8 b=2/3 and the pure hour-rotation model for n 1..24.
## Tests
- `npx vitest run tests/unit/spine-p1`: Test Files 5 passed (5), Tests 87 passed (87). Plus spine-ingest, spine-phi: green.
- M12-style mutant (revert to `TICK_MS` on due ticks): run, but its output was lost to a timeout; the model test's old-starvation cases (n=4 b=1) are the kill. UNVERIFIED as run; not re-run.
- Gate (.bc/gate.log, 4 workers, one run): typecheck 0, typecheck:tests 0; `Test Files  4 failed | 509 passed | 1 skipped (514)`, `Tests  4 failed | 10333 passed | 7 skipped (10344)`; gate=1 (vitest failure stopped the chain, so build and check:silent did NOT run in this gate: UNPROVEN).
- 4 failures: e11-silent-room-window (SWEEP) and no-identity-literals are base failures (R3 refute). spine-queue and spine-s6-pg claim tests fail on the real clock (claim route blocks K lanes :20-:45 IST via kLaneBlockedNow; I ran at that time); unrelated to producers.ts (neither imports it). R3's report saw the same pair flaky. Not re-run outside the window.
## Assumptions / risks
- Bound n-b+1 uses b capped at n. Swift N/A on Linux.
