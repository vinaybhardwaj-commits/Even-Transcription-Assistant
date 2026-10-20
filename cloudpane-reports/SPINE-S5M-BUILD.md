# SPINE-S5M-BUILD — S5 and S6 rebased onto main (after S0, PR #182), stacked on S1
Branches: spine/m-s5-queue 425a5337 (off origin/spine/m-s1-signals 5b835a38); spine/m-s6-free = S5 + S6 files (tip in .bc/spine-s5m.done).
## What changed
- S5: files of the "spine S5" commits on origin/spine/s5-queue (1db61d55), copied verbatim, except lib/spine/auth.ts and lib/spine/config.ts (reconciled).
- S6: files of the "spine S6" commits on origin/spine/s6-free (e3cdada1), copied verbatim. S6 did not touch auth.ts or config.ts, so no re-reconciliation.
- auth.ts: S1's bearerToken/bearerMatches (scheme "Bearer ", case-insensitive scheme as S1 tests need; sha256 + timingSafeEqual) plus checkSpineBearer (S5) built on bearerMatches: 503 unset, 401 missing/wrong. Env names stay separate: S1 routes keep SPINE_INGEST_TOKEN_ENV / CRON_SECRET, S5 routes SPINE_BEARER_TOKEN.
- config.ts: S5's file (Mode, parseMode, isKilled, modesFrom, readModes, readMode, paid-stage-off, KNOWN_STAGES) + S1's parseIngestMode (ingest value decoded from text, kill_switch never decoded) now using isKilled; IngestMode = Mode. Kill semantics are identical in both (anything but exactly false / {on:false} is killed).
## Tests (own runs)
- typecheck, typecheck:tests: exit 0 on both tips. S5 targeted: 6 unit files 76 passed; 3 pg files 33 passed. Test files not edited.
- pytest tools/eta-spine on S6 tip: 200 passed (one earlier run, concurrent with the full suite, showed 1 failed / 199 passed; two reruns alone: 200 passed. Cause not identified: flaky under load).
- Full gate on S6 tip (.bc/gate.log): "Test Files  2 failed | 464 passed | 1 skipped (467)", "Tests  2 failed | 9549 passed | 5 skipped (9556)", gate=1. Both failures are in files this lane does not touch and fail identically on origin/main in a clean worktree: e11-silent-room-window (THE SWEEP) and no-identity-literals (tools/eta-consult-steward, tools/ubus). Because the chain stopped there, build and check:silent were run separately: npm run build exit 0; check:silent exit 1 with 9 findings (the accepted pre-existing 9, none in spine files).
- swift build/test: N/A on Linux. No mutants run (verbatim copies).
## Checks
- `git diff origin/main -- db/` empty on both branches (no stale 0173).
- For every S5 and S6 file except auth.ts/config.ts, `git diff <refuted tip> <branch> -- <file>` is empty.
## Assumptions / risks
- Unified auth keeps S1's case-insensitive scheme; S5's strict case-sensitive "Bearer" was loosened to match S1 (tests of both pass).
- config.ts now imports @/lib/db at top level for S1's callers too; S1 suites pass.
- Two unrelated main failures need their own owner.
