# SPINE-BACKFILL-R2-BUILD (spine/backfill-drain on b2237181, builder Sonnet, c3) — fixes F1-F4 from the R1 Opus refute
Still ships OFF (SINCE unset = no query, no probe, no field). No migration, no new column, no new table.
## Changed
- F1 lib/stt/auto-drain-backfill.ts `routerHealthy(fetch, env, maxAgeMinutes)`: probes what a job will use. BULK_AGE_MINUTES unset -> ordinary list only; set -> bulk list WITHOUT the POOL_BULK_FALLBACK_LIVE tail (a dead bulk pool cannot pass because the Mini answers) and, if BULK_AGE > max-age (some backlog windows are younger), the ordinary list too; every list needs one ok. A bad BULK_AGE counts as off (as the job reads it).
- F2 auto-drain.ts / route: backfill cap = min(AUTO_DRAIN_BACKFILL_LIMIT, caller limit); route forwards `limit` only when ?limit was given. Response keeps `cap` (live) and adds `backfill_cap`; result.backfill.cap too.
- F3 scan SQL: `DISTINCT ON (room_id) ... ORDER BY room_id, end_ms DESC, start_ms DESC, closed_at DESC, id` (= orderAutoDrainOffers' order). Blind ids go INTO the SQL (`<> ALL`) so a blind newest window cannot hide a room's older one. `candidates` now means rooms with a candidate.
- F4 permanent refusals (too_long, no_room_day, not_found, wrong_state except claim_lost): backfill stamps `<step>#<n>` in the EXISTING auto_drain_refused_reason column; scan skips n >= 3 (3 = the drain's DRAIN_MAX_ATTEMPTS, "three tries, then park"). Transient steps keep the plain cooldown, uncounted. Live windows keep the plain text. Tick log gains parked_permanent and cap. Dead `backfillOffered` removed.
- Tests: tests/unit/auto-drain-backfill.test.ts (TRUNCATE-as-reset steps replaced by newer rows / fresh fixtures); tests/unit/auto-drain-backfill-oref.test.ts (the refuter's 16 adversarial cases adopted + F1 x6 env combos, F3 differential, F4 x3); frozen copies tests/support/auto-drain-main-baseline.ts (parent) and auto-drain-backfill-r1.ts (R1) for differentials; allowlist pin 6 -> 7 (read-only COUNT).
## Tests (own runs)
- Targeted backfill + oref: all pass (oref file 26, builder file 25); s1-auto-drain + room-access-gate: `Test Files 2 passed`, `Tests 71 passed`.
- F3 proof: 25 random fixtures (rooms, refusals, jobs, exact slot ties, blind), R1 fetch-all-then-pick vs new SQL pick -> identical offers. Live differential vs parent (12 fixtures) still passes.
- Full gate (.bc/gate.log, 4 workers): typecheck OK, typecheck:tests OK, `Test Files 1 failed | 523 passed | 1 skipped (525)`, `Tests 1 failed | 10478 passed | 7 skipped (10486)`. The 1 failure = room-access-gate allowlist pin (my new COUNT query mentions bench_window a 7th time); fixed by the pin bump, re-run alone: passes. Because `&&` stopped there, build and check:silent were run separately afterwards: `build=0`; check:silent `Found 9` = the accepted 9 (none in changed files). A second FULL suite was not re-run (one-gate rule); 0 new failures otherwise. swift N/A on Linux.
## Mutants: 9/9 killed
F1: always-bulk, keep-fallback-tail, skip-ordinary. F2: cap ignores caller. F3: blind not in SQL, order ASC. F4: no parking, transient counted, count suffix on live windows.
## Index proposal (NOT applied; for fable)
`CREATE INDEX CONCURRENTLY idx_scribe_job_room_window_wid ON scribe_job ((args->>'window_id')) WHERE kind = 'room_window';` (next free migration number to be chosen at approval).
EXPLAIN on the refuter's volume fixture (9 rooms x 61 d, 60k scribe_job of which 20k room_window): scan Execution 27.7 ms -> 26.5 ms (Seq Scan on scribe_job becomes a Bitmap Index Scan, but the hash anti join still reads all room_window rows). Gain ~4%: NOT worth a migration at this volume; revisit only if room_window jobs reach the hundreds of thousands. Raw: .bc/oref-explain.txt. Wire cost fixed by F3: 9,720 rows -> 9 rows per tick; scan 28 ms.
## Assumptions
- N=3 permanent refusals; permanent set as above (wrong_state claim_lost is a race, so transient).
- Reason text carries a `#n` suffix for backfill windows (visible in the room-day admin/MCP views as e.g. `too_long#2`).
- Route: ?limit absent -> backfill uses its own cap (otherwise the live default 1 would silently halve it).
## Open risks
- The `#n` text counter relies on the one stamp per tick; a window parked at 3 stays parked until the reason is cleared by hand (a successful enqueue clears it as before).
- wrong_state/claim_lost wording is read from the drain's detail string.
