# MAIN-GREEN-BUILD (lane spine-main-green, branch spine/main-green-fix off origin/main 6166e3e7)

## Root causes and fixes (tests/fixtures only; no production code touched)
1. e11 THE SWEEP 41 vs 34: 7 Python/sh files (`/inference` hits) were unclassified: services/eta-emotion/app.py, services/eta-indic/{indic_server.py,install-indic-launchd.sh}, services/eta-router/{router_server.py,test_stt_hygiene.py}, tools/router-fix/{router_server.py,test_stt_hygiene.py}. Added 7 SITES rows (not_a_window_reader, reasons given; no PATHS row since none reads a window into the app). Test: tests/unit/e11-silent-room-window.test.ts (SITES).
2. jev-p2 bench CLI no args: the test ran `npx tsx`, but tsx is not a dependency, so npx fetches it from the network (hangs/fails offline). Test now runs `npx --no-install vite-node -c vitest.config.ts scripts/jev-bench.ts` (installed; the config supplies the "@/" alias). Exit 2 + usage unchanged. It passed locally only because tsx was in the npx cache.
3. no-identity-literals (19 offenders): fixtures rebuilt. Python cannot import makeFakeClinician, so added tools/eta-consult-steward/tests/fake_identity.py (fake_label/fake_email, assembled from parts); conftest/test_fixes/test_phi/test_tools use it, leak assertions now check the fake names. tools/ubus tests: connection-URI host and the "Dr." term changed to fake values (filter.test.ts, v3-r4.test.ts).
4. spine-artefacts-r2-oref A8: wall clock `< 5000` ms (4.3 s alone, over 5 s loaded). Replaced with a work guard: every Seq Scan of reb_track_index/spine_link in EXPLAIN ANALYZE has loops <= 10 (a per-row correlated probe would show thousands), at least one such scan must exist, plus a 60 s gross-hang net.

## Files by owner area
- ETA tests: tests/unit/{e11-silent-room-window,jev-p2-sets-builders,spine-artefacts-r2-oref}.test.ts
- consult-steward (fixtures only): tools/eta-consult-steward/tests/{conftest,test_fixes,test_phi,test_tools}.py, new fake_identity.py
- ubus (fixtures only): tools/ubus/test/{filter,v3-r4}.test.ts

## Verification
- Targets alone x3: e11 + jev-p2 + no-identity: "Test Files 3 passed (3) / Tests 77 passed (77)" three times; spine-artefacts-r2-oref: "Tests 9 passed (9)" three times (A8 4.2-4.5 s).
- steward pytest (PYTHONPATH=.): 74 passed, 4 failed (boto3/botocore not installed here: test_creds x2, test_fixes x2; unrelated, env). ubus node tests: pass 377, fail 0 (tsc build prints pre-existing node:sqlite type errors, dist still emitted).
- Full gate (.bc/gate.log): typecheck + typecheck:tests OK; vitest "Test Files 507 passed | 1 skipped (508)", "Tests 10243 passed | 7 skipped (10250)", 0 failed; build "Compiled successfully"; check:silent "Found 9 silent-failure handler(s)" = the accepted pre-existing 9, so gate=1 is only that. swift N/A on Linux.

## Assumptions / risks
- Repro note: failures 1 and 3 reproduced at base here; 2 and 4 did NOT fail locally (2: tsx cached; 4: 4.3 s < 5 s) so those root causes are from reading, not reproduction. The refuter should confirm 2 on a machine with no npx cache.
- no-identity guard reads working + staged copy, so changes must be staged before it runs.
- No migration, no production code, no model ids.
