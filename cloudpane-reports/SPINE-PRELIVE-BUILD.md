# SPINE-PRELIVE-BUILD — pre-live hardening (A-F), branch spine/prelive-hardening off main 3380cf9c. Nothing goes live; no mode/config change; nothing paid.
## Changes
- A: lib/spine/retry.ts RELEASE_BACKOFF_MS 60 s -> 180 s (RUNNER_POLL_MS x 3: survives two full polls plus slack). Tests updated (spine-artefact-r4, spine-queue-pg, spine-s6-pg); new test reads runner.py DEFAULT_POLL and pins backoff >= 2 polls + 1 ms.
- B: tools/eta-spine/executors.py. Handler only raises Terminated(SystemExit, 128+signum); _run_group kills+reaps the group in an except path, outside the handler. First signal wins, later ones are ignored (no re-entry, no interrupted wait). New tools/eta-spine/tests/test_prelive_b.py.
- C: lib/room-access/readers/spine-artefacts.ts nemotronPageSql: inner `ORDER BY pk LIMIT n` picks the page, blind is computed over those rows. New tests/unit/spine-nemotron-page-pg.test.ts.
- D (code): lib/spine/jobs.ts openBreakers reads only when a failure newer than BREAKER_OPEN_MS exists (indexable range), then the last 20 as before. New tests/unit/spine-tick-breaker-pg.test.ts.
- D (schema, SEPARATE commit 67aea26a, WAITS ON FABLE'S APPROVAL, applied nowhere): db/migrations/0177_spine_tick_breaker_idx.sql (CREATE INDEX IF NOT EXISTS spine_tick_kind_at_idx (kind, ticked_at DESC, id DESC)), db/rollbacks/0177_*.down.sql. 0177 free on main and every branch (highest seen 0176). Retention proposal below.
- E: ALREADY IN MAIN (runner.py run_once releases jobs[i+1:] after a refusal; tests test_n4_*). No change; mutant (loop removed) killed by 2 existing tests. In --live limit is 1, so the case is reachable only with limit>1.
- F: content/ETA-BUG-LOG.md B32 marked NOT REACHABLE (ruling text); tests/unit/spine-b32-multimachine-pg.test.ts pins 2 encounters, both multi_machine, 0 rows on a rerun (rerun = revision-2 re-ingest, no DELETE). merge.ts untouched.
## Tests (own runs, c3)
- Fail-before: A 2 failed/29 passed on old retry.ts; B 4 failed/1 passed on old executors.py; D old statement 300194 plan rows vs 87 bounded.
- typecheck + typecheck:tests: 0 (.bc/gate.log). Vitest, 4 shards, 4 workers, foreground (.bc/gate-s1..s4.log): 2312/2312, 2760 passed+2 skipped, 2752 passed+1 skipped, 2608 passed+4 skipped; 0 failed. build 0. check:silent "Found 9" (accepted, 0 in spine). swift N/A on Linux. Kiosk suite untouched.
- Shard 1 first failed on spine-artefacts-r2 "ORDER BY .+ LIMIT 2000$" (my C had no outer LIMIT): fixed, shard rerun green. Shard 4 first showed 11 container-readiness failures (pg-harness, spine-p2-oref*) while I ran a targeted vitest in the same worktree; rerun clean.
- pytest tools/eta-spine: 303 passed (-n 4), 8 runs, 7 clean.
## Mutants (all killed unless noted)
- A 60 s: killed. B old handler: killed (4). C inner LIMIT removed: killed (2). D EXISTS bound removed: killed (2). E release loop removed: killed (2).
## Findings / assumptions
- C: F-B is NOT reproducible on postgres:16. The OLD statement already defers its subplans past the LIMIT (Result above Sort); its work stays flat when room_diarize_window has an index. The refuter's growth matches the test stub's unindexed room_diarize_window (seq scan 4000 rows x 1600 loops), not a table-wide blind. The fix is a structural fence with identical rows (equality on 3 fixtures x 3 blind sets x 4 cursors). The guard's negative control is therefore a MATERIALIZED table-wide shape (16.2M vs 1.6M plan rows), not the old SQL as written. UNPROVEN that production ever ran table-wide.
- B: the storm test test_sigterm_storm_no_orphan hung 1 run in 3 at base under load (refuter saw the same); 8 runs after the fix, 1 hang (first full run), 7 clean; could not reproduce in 280 isolated storms. Possible residual flake, cause not pinned.
- A: margin is against the default 60 s poll; SPINE_POLL_SECONDS above 180 would defeat it (stated in the retry.ts comment).
- D: bounded read needs failed ticks to have counts->>'failed'='1' (as written by reportJob). Retention proposal (not built): prune spine_tick kind 'attempt:%' older than 7 days, batched, after fable's ruling; 'cron:*'/'merge' kinds are cursors, keep.
- N1 (relay heal_escalated, gating-lead's area): untouched, report only.
- venv: repo has no requirements file (stdlib + pytest); used ~/dev/spine-venv (pytest, xdist); no global installs.
