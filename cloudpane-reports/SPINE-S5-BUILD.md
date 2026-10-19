# SPINE-S5-BUILD — queue + runner, dry (branch spine/s5-queue, off spine/s0-schema)
## Changed
- lib/spine/retry.ts (pure: backoff, IST day, outcome resolution, breaker), config.ts (modes; missing/malformed = off; paid stages always off), auth.ts (bearer: SPINE_BEARER_TOKEN, 503 unset, 401 wrong), jobs.ts (enqueue, claim SKIP LOCKED, owner-matched report, reapExhausted, openBreakers, D13 notifier).
- app/api/spine/claim, app/api/spine/report. tools/eta-spine/runner.py (+ tests), units/spine-runner.service (NOT installed).
- tests/unit/spine-queue-pg.test.ts (postgres:16 + 0173, unedited), tests/unit/spine-queue.test.ts. No migration touched; 0173 not on origin/main.
## Tests (own .bc/gate.log; --maxWorkers=4 --minWorkers=1, needed: plain --maxWorkers=4 errors "minThreads/maxThreads conflict")
- typecheck, typecheck:tests: pass. vitest: "Test Files 2 failed | 451 passed | 1 skipped (454)", "Tests 2 failed | 9363 passed | 5 skipped (9370)".
- The 2 failures are NOT in spine files: e11-silent-room-window (Whisper call-site sweep, lists services/ and tools/router-fix files) and no-identity-literals (tools/eta-consult-steward, tools/ubus tests). Not compared against a base run: UNVERIFIED that they are pre-existing.
- Because vitest failed, build/check:silent were run separately: build exit 0; check:silent "Found 9 silent-failure handler(s)" (accepted baseline, none in spine). swift build/test: N/A on Linux.
- Spine tests alone: 25 passed (13 pg, 12 unit). pytest tools/eta-spine: 8 passed.
## Mutants (all killed)
- jitter cap dropped (cap before jitter): killed (backoff unit). permanent retries: killed (2). budget increments attempts: killed (2). no SKIP LOCKED: killed (live second-session lock test, 4.3 s wait). owner match dropped from BOTH select and update: killed; dropping either alone SURVIVES (equivalent: the other guards; only a race separates them).
## Assumptions
- spine_config keys: kill_switch, jobs, mode.<stage>, dead_alert (values "off|shadow|live" or {"mode":..}). Guessed; S0 seeds none.
- Report outcomes added beyond the brief: shadow and release (both give the attempt back). The would-run CLI is logged by the runner only; spine_job has no column for it.
- Breaker is derived at read time from done_at of the last 20 done/failed/dead rows (transient retries are not counted), min 5 samples, open 30 min after the latest failure.
- Dead sink: default notifier is a no-op; queueOpsAlert is used (kind heal_escalated, room spine-<stage>, dedupe by stage/hour) only when spine_config dead_alert is live. The 6 h per-stage ubus cap is not built. heal_escalated may not suit room_alert_outbox_kind_chk semantics: UNVERIFIED.
- Runner CLIs per stage (module names) and the use of encounter_id as the uid are placeholders for S6. Live exit-code map 0/75/2/70 is mine.
- A runner that dies on attempt 6 is reaped to dead by reapExhausted (called from claim).
## Open risks
- Bearer env name may differ from S1's; merge round dedups. Concurrency-per-stage limits not built.
