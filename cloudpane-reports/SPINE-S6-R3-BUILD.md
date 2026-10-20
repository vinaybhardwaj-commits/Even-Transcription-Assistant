# SPINE-S6-R3-BUILD (spine/s6-free, on 991bc62a). Fixes the Opus R2 refute.
## Changed
- F6 HIGH: lib/spine/artefact.ts. Closed track shape `{layer}.{engine}__{version}__{cfg8}.json`, lanes acoustics.room_profile_acoustics, diar.nemotron, stt.koyal, stt.medasr (clip_lanes LANES), plus consult.flac. Word+date screen on the version only; directories and free file names get word, date and 8-digit screens.
- F1b MED: executors.py returns `release` for hourly_gap and for budget < 300 s (budget_too_small); new lib/spine/window.ts + claim route: live claims skip acoustics/nemotron from :20 to :45 IST.
- LOW: _env_window (from >= to -> defaults + one stderr line); getmtime race -> transient artefact_missing; Popen/_children.add race closed by blocking SIGTERM/SIGINT across spawn+register (child gets old mask via preexec_fn).
- Tests: tools/eta-spine/tests/test_adv_r2.py (ported + adapted), tests/unit/spine-s6-r3-pg.test.ts (ported + R3, real reportPOST/claimPOST on pg), tests/unit/spine-window.test.ts; test_executors.py hourly tests updated for release/budget.
## Tests
- pytest tools/eta-spine: 136 passed.
- Gate (my .bc/gate.log, `--maxWorkers=4 --minWorkers=1`; the prescribed bare `--maxWorkers=4` errors here with "minThreads and maxThreads must not conflict"): typecheck 0, typecheck:tests 0; vitest "Test Files 2 failed | 454 passed | 1 skipped (457), Tests 2 failed | 9409 passed | 5 skipped (9416)". The 2 failures are the known base pair (e11-silent-room-window, no-identity-literals in tools/eta-consult-steward), none in spine files.
- Because the chained gate stopped at vitest, I ran separately: npm run build exit 0; check:silent = the 9 accepted findings, none in spine. Swift N/A on Linux.
## Mutants
- Python 42: all killed except R1-2 PAID_STAGES (documented equivalent). R2-3 killed after fixing its pattern. R2-4/R2-5 killed by hang/timeout.
- TS 30/30 killed (R2 set, R1 set, new: lanes removed, consult.flac, dir/version screens, anchor, window ignored, window bounds, release counted as tick). R1-T7 now killed too.
## Assumptions
- Unknown-lane file names are "free parts": accepted if they pass the full screens.
- Window is fixed 25/45 on the server side (box env may differ; the executor release is the backstop).
- Min budget 300 s means K lanes are not claimed from :20.
## Open risks
- Carried from R1/R2: F5 (two active links), F7 (non-deterministic FLAC sha); no production enqueuer yet. Jev not available in this session.
