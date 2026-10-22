# MAIN-GREEN-R2-BUILD (spine/main-green-fix, on top of 5ff8cb6c)
## Changed
- lib/room-access/readers/spine-artefacts.ts catalogPageSql: joins moved inside an `OFFSET 0` fence, ORDER BY/LIMIT outside. Root cause: with LIMIT the planner expected early stop and used Nested Loop over Materialize(rd) (rows 50917 x loops 2000, 101,832,780 removed by join filter, 4.3 s / 8.2 s EXPLAIN ANALYZE). Fenced, it hashes rd on r2_key: 549,503 plan rows, 0 join-filter discards, ~0.7 s. Columns, blind/dup semantics and cursor unchanged.
- tests/unit/spine-artefacts-r2-oref.test.ts A8: self-contained (creates its own encounter); asserts old-vs-new result equality (count + md5) with no blind set and with a blind room-day; asserts from EXPLAIN (ANALYZE) max "Rows Removed by Join Filter" <= K = 10 x page (20,000) and sum(rows x loops) <= 400 x page scaled by reb rows (800k at 60k, 1.6M at 120k); no wall clock. OLD SQL kept verbatim as negative control; also run at 2x data (120k reb + 120k link).
- tools/eta-consult-steward/tests/test_fixes.py: partial probes restored from fake_label parts ("Clinician", counters) in test_index_values_sanitised and test_alerts_free_text_dropped. No steward production change.
## Evidence
- A8 fixed: {"maxJoinFilterRemoved":0,"work":549503}; old: {"maxJoinFilterRemoved":101832780,"work":102312511}. Spine-artefacts-r2-oref file x3: "Tests  9 passed (9)" each.
- Negative control on production code: reader reverted to old SQL -> A8 FAILS "fixed: join-filter discards: expected 101832780 to be less than or equal to 20000"; reader restored -> passes.
- Steward pytest with boto3/google-auth/requests in /tmp target: "78 passed". Mutant (alert message leaked with "Dr " stripped) fails test_alerts_free_text_dropped (killed).
- Gate (.bc/gate.log): typecheck, typecheck:tests OK; "Test Files  507 passed | 1 skipped (508)", "Tests  10243 passed | 7 skipped (10250)", 0 failed (includes room-access-gate, no pin); build "Compiled successfully"; check:silent "Found 9" = accepted 9, so gate=1 is that alone. swift N/A on Linux.
## Assumptions / risks
- "Linear in page size": the plan scans whole tables, so the work bound scales with reb rows; stated in the test comment. Fixed measures ~550k vs bound 800k (margin 1.45x); old is 100x over.
- The fence reads every row after the cursor each page (as the old sort did); no index or migration added.
