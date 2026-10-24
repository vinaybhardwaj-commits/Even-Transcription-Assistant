# SPINE-S6LIVE-BUILD — S6 live readiness (recut, acoustics, nemotron). Branch spine/s6live-readiness. Builder: Sonnet on c3.
Audit + runbook (the long form, with file:line gaps G1-G12): cloudpane-reports/SPINE-S6LIVE-RUNBOOK.md. Nothing was started, installed or applied; no DB other than throwaway postgres:16.
## Changed
- tests/unit/spine-s6live-e2e-pg.test.ts (new): real claim/report routes (loopback) + REAL `runner.py --live --once` (python3, clock pinned) + fake cutter/clip_lanes CLIs, postgres:16 with ALL migrations. 8 tests.
- app/api/spine/claim/route.ts: a live claim needs jobs=live (F1). tools/eta-spine/executors.py (+test_executors.py): recut timer gap = release (F2). lib/spine/enqueue-store.ts INSERT_SQL: revive a blocked job once a consult_uid link exists (F3).
## Proven by the e2e test
queued -> leased (seen at report time) -> done for recut, then acoustics + nemotron; artefact rows written once with store=box, object_key and the sha of the file; a re-run pass runs no tool; a transient error backs off and opens the breaker, the retry succeeds with ONE artefact; a repeated report = 409 lease_lost, nothing written; a crashed runner's lease is re-claimed and still one artefact; a paid stage (config live + a hand-queued job) is never claimed; mode off/shadow, jobs off/shadow, kill_switch on and malformed all stop new claims, flipping back resumes; K lane not handed out at :30 while recut is; blocked (no link) spends nothing and comes back on link. No DELETE; each test has its own IST day.
## Mutants (e2e file, one run each): M1 drop the jobs=live guard KILLED (mode-flip test); M2 disable the unblock revive KILLED (blocked test); M3 timer_gap back to transient KILLED (timer-gap test).
## Gates (own logs)
- .bc/gate.log + .bc/vitest.log: typecheck=0 (typecheck + typecheck:tests); vitest "Test Files  530 passed | 1 skipped (531)", "Tests  10508 passed | 7 skipped (10515)", exit 0; build=0; check:silent exit 1 = the 9 accepted pre-existing findings, none in files touched here (0 new).
- First full run had 2 failures in tests/unit/spine-queue.test.ts (mocked jobs=shadow + live claim, now invalid by F1); fixed the tests (jobs=live) + added a jobs=shadow test; rerun above is clean.
- pytest tools/eta-spine (serial): 298 passed. Under -n 4 beside another lane's vitest, test_adv_r3 sigterm_storm flaked once and once in a serial run under load; passes alone (29/29 twice) and also at the base code. swift: N/A on Linux.
## Assumptions
- The runbook sits in a second file because this report is capped at 40 lines. Cutter paths (~/oc/consult/...) come from the unit files in tools/eta-consult-cutter; the lab dir is the eta-lab checkout holding kit/ (mirrors/eta-lab/kit/reb/clip_lanes.py has the CLI the executor assumes: --lane/--consult/--write/--worker-status all verified there). Box hostname and paths UNVERIFIED.
- Migration number: none added (0173-0177 exist; 0173 was already on main). No model ids, no secrets, synthetic ids only.
- Moved the cron-visible behaviours F1-F3 rather than listing them: each is <10 lines and in spine scope. Not touched: modesFrom (spine-queue.test pins jobs=shadow + mode live = live there).
## Open risks
G1 no per-room scoping (the biggest: a flip queues every room's recent encounters); G3 1 job/minute; G6 FLAC determinism UNVERIFIED; G9 recut child env UNVERIFIED. Linux pytest under -n 4 once failed test_adv_r3 test_sigterm_storm_no_orphan[0] while another lane ran vitest; serial run: 298 passed.
