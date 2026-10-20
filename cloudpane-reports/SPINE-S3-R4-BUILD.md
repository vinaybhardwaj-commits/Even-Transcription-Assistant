# SPINE-S3-R4-BUILD: blindness by room-day, reader owns its SQL (branch spine/s3-artefacts, on b34165a9 + merge of origin/spine/s2-merge 83c41733)
## Changed
- lib/room-access/readers/spine-artefacts.ts: rewritten. `rebPageSql / nemotronPageSql / catalogPageSql` with explicit FROM/JOIN, run by `readRoomPage(q, src, cursor, days, limit)`. Blind = the row's (IST date, room) in BLIND_ROOM_DAYS, bound as `$2 text[]` of `date|room` keys (scratch twin listed too). No window-id list.
- lib/spine/artefacts.ts, artefacts-store.ts: no room-table SQL left (scanner: 0 hits in both). `blindIds`/blindWindowIds removed; `opts.blindDays` defaults to BLIND_ROOM_DAYS. consult_index, sarvam and freescript pages now also carry `blind` (own pair / their consult's consult_index pair).
- Per source: reb = own ist_date/room_id (consult-clip tracks included); nemotron = room_day_id or its window's bench_window / room_diarize_window day; catalog = own pair, its consult_index day, or an r2 key that is a blind reb ref; dup probe only matches non-blind reb rows.
- Tests: new spine-artefacts-r4.test.ts (12) + tests/support/spine-room-stubs.ts; r3/default-blind/pg/r2/r2-oref updated for the new params (stub room_day/bench_window/room_diarize_window in their pg setup).
## Tests (own runs)
- spine-artefacts* + room-access-gate (7 files, no pin): all pass (r4 12, r3 5, default-blind 3, pg 14, r2 16, r2-oref, gate 12).
- Full gate (.bc/gate.log): typecheck + typecheck:tests pass; vitest "Test Files  2 failed | 463 passed | 1 skipped (466)", "Tests  2 failed | 9511 passed | 5 skipped (9518)". The 2 failures are e11-silent-room-window and no-identity-literals, the same 2 the R3 refute recorded at base; none in spine. build=0 (re-run on its own, the && chain stopped at vitest). check:silent: 9 accepted findings, 0 in spine (exit 1 as at base). swift: N/A on Linux.
- Gate note: `--maxWorkers=4` alone throws "minThreads and maxThreads must not conflict" on this 24-core host; I used `--maxWorkers=4 --minWorkers=1`. The full run hit the 600 s tool cap and finished in the background, still one suite at a time.
## Cost (A5: 14 pairs, 20,000 reb, 5,000 nemotron, 2,000 catalog consults x 2 layers, half the reb rows blind)
- reb page 27 ms, catalog page 46 ms (was 2.34 s); whole 6-page run 2.3 s of which nearly all is docker psql round trips. First try (unnest + OR) gave a 4 s nested loop; a single `text[]` key list fixed the estimate.
## Mutants (/tmp/spine-s3-r4-mut/mut.py; each run against 6 spine test files, sources restored and cmp-checked)
- 22 of 23 killed: blind false per source (M1-3), N9 any-encounter / inactive link (M4-5), L2 page key (M6), nemotron own-window day (M7), consult_index dup (M8), blind after orphan / after dup (M9-10: the refute's A2/A5), params empty (M11), L1 key (M12), default ignored (M13), page failure swallowed (M14: the refute's S1 class), NEW room-day predicate dropped (M15), consult tracks unfiltered (M16), catalog unfiltered x2 (M17-18), consult_index / sarvam+freescript unfiltered (M19-20), scratch twin (M21), unresolvable day (M22).
- M23 (dup probe also counts blind reb rows) SURVIVES: equivalent, because a blind reb ref makes the catalog row blind first. Not killed.
- The refute's own 17-mutant script targets the old window-id code and does not apply; its classes are the M1-M14 set above.
## Assumptions
- A nemotron row whose room day cannot be resolved is blind while BLIND_ROOM_DAYS is non-empty (fail closed; it is only marked and counted). With the empty set nothing changes.
- sarvam and freescript rows are held out by their consult's consult_index day (not in the brief's list; safer reading).
- Catalog rows with no ist_date/room_id and no consult_index row are not blind (nothing to judge by).
## Open risks
- Live behaviour with a refilled set is proven on a throwaway pg16 with stub room tables, not on the real room_day / bench_window schema. UNVERIFIED against production data.
