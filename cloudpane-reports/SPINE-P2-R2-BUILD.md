# SPINE-P2-R2-BUILD — fix round R2 on spine/p2-writer (base 46dd638d). Sonnet builder.
## Changed
- lib/spine/enqueue-store.ts F1: SUPERSEDE_SQL also supersedes queued/shadow jobs whose stage is not in stagesFor(e) (close grace ignored, so only status/flag drops count). Leased/done untouched.
- lib/spine/merge-store.ts:
  - F2: `moved` only takes a link from an encounter of THE SAME room-day (new params $4 room, $5 date). Chosen over loading cross-day links: smallest change, the first day to claim a cross-day key keeps it, a re-merge of either day writes 0 rows, frozen encounters of other days are never touched (I4). writeMerge now takes (r, room_id, ist_date).
  - F3: B is anchored to the cursor: window start = cursor.mx - RECENT_MS, and B selects days with a signal in that window that is still UNASSIGNED (encounter_id IS NULL). Without the unassigned filter a quiet system re-merged the last days on every pass (existing "days: 0" tests failed); the merge assigns every signal it places, so a swept day drops out.
  - F4: MAX_FAILS = 3 consecutive failures, then the cursor passes the day (3: one transient error or two bad deploys never skip a day; a poison day holds the queue 3 passes, not forever). Tick counts gain `failing` [{k:"room|date", n}] (cap 100, oldest dropped), `skipped_keys`, and `skipped_days` (also in the return). No PHI (opaque room id + IST date). A skipped day is retried whenever A/B/C selects it; one success clears it.
  - PERF: loadDay uses `t_open >= IST-midnight AND t_open < next IST-midnight` instead of the cast; same rows (test compares old vs new predicate on 8 edge instants incl. 18:30:00Z +/-1 us, 4 days).
- tests/unit/spine-p2-oref-pg.test.ts: the refuter's file moved, asserts unchanged. Edits: poison+cap test runs 4 passes (MAX_FAILS 3 + 1) instead of 2; typecheck fix (`attrs?.`); the 2 F5 shape tests are `it.fails` (they fail on merge.ts; F5 out of scope); added tests PERF equality, PERF midnight, F4 skip/retry/clear.
## Tests (own .bc/gate.log + reruns)
- spine-p2-oref-pg + spine-p2-pg + spine-p2: 6 DEFECT repros FAIL -> PASS (F1, F2, F3, F4 poison+cap; F2/F3 variants).
- Full gate, 4 workers: typecheck + typecheck:tests clean; `Test Files 515 passed | 1 skipped (517)`, `Tests 10356 passed | 7 skipped (10398)`, `Errors 2 errors`: vitest worker RPC timeouts ("onTaskUpdate") under machine load, attributed to tests/unit/consult-index-pg.test.ts (unrelated); rerun alone: `Tests 44 passed (44)`. So the gate's exit 1 = those 2 worker errors, 0 test failures. build exit 0. check:silent `Found 9` = accepted pre-existing. swift: N/A (Linux).
## Mutants (revert one fix, its repro must fail)
- F1 (drop stage predicate): killed. F2 (drop same-day EXISTS): killed. F3 (anchor to now): killed. F4 (MAX_FAILS huge): killed (F4 test).
- PERF upper bound `<` -> `<=`: SURVIVES at behaviour level (mergeSignals ignores out-of-day signals, so the midnight-edge signal is harmless); covered only by the SQL equality test. Equivalent mutant, not killable through the writer.
## Assumptions / open
- F5 untouched (merge.ts unchanged). 2 pure F5 shape tests are it.fails: they flip red when F5 is fixed.
- F1 also supersedes queued/shadow jobs of a `frozen` encounter (stagesFor = []): consistent with "frozen gets nothing"; frozen encounters are outside the 72 h read anyway.
- A skipped (poison) day whose signal is unassigned stays in B while it is inside cursor.mx - 10 min, so it is retried (and logged) each pass until the cursor moves on; non-blocking.
- Migration: none added.
