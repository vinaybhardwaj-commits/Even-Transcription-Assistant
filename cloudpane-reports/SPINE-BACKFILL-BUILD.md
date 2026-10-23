# SPINE-BACKFILL-BUILD (branch spine/backfill-drain, builder Sonnet on c3)
Ships OFF: AUTO_DRAIN_BACKFILL_SINCE unset = no query, no probe, no result field. No schema change, no migration, no write added.
## Changed
- lib/stt/auto-drain-backfill.ts (new): SINCE parse (IST date), LIMIT (default 2, clamp 1-5), load guard, backlog scan SQL.
- lib/stt/auto-drain.ts: seam only. Backfill runs when SINCE is valid AND the live set offered nothing AND the guard passes; it then uses the same orderAutoDrainOffers and the same offer loop (enqueueSubject, drainRoomWindow(w.id, origin, actor), refusal stamp). Result gains `backfill` only when SINCE is set.
- tests/unit/auto-drain-backfill.test.ts (new, 24 tests, pure + postgres:16); tests/support/room-access-allowlist.ts (+1 entry, the room-access guard names SQL files).
- NO CLOCK GATE (fable/V CHANGE 13:33 IST): the off-peak window, its env vars and tests were removed; a test asserts no clock/hour code in the module.
## Selection
Closed, grid-aligned, room_day set, Transcript-on room, closed_at >= SINCE (IST midnight) and < now - AUTO_DRAIN_MAX_AGE_HOURS, not refused inside the cooldown, NO room_window job in any state. Blind windows removed in JS as the live scan does. One per room, newest end_ms first, rooms least-recently-served first (24 h look-back).
## Load guard (skip the tick, reason in result.backfill.skipped and the log; live draining never consults it)
router_unhealthy (GET <bulk-pool router base or default>/healthz, 4 s, withServiceAccess, parsed ok:true), in_flight_at_limit (queued+running room_window jobs >= LIMIT), recent_failure_rate (>30% of last 10 finished in 12 h, min sample 5), recent_latency (avg started->finished > 1800 s: 2x a 900 s window, ~3x the 613 s longest measured router run).
## RTF and throughput (existing columns only)
RTF = audio s / processing s: `scribe_job.result->>'audio_seconds'` over `finished_at - started_at` (kind room_window, status done); fallback audio s = (bench_window.end_ms - start_ms)/1000. started_at->finished_at includes poll hand-backs, so it is wall time, not engine time.
```sql
SELECT date_trunc('day', finished_at AT TIME ZONE 'Asia/Kolkata') AS ist_day, count(*) AS windows_done,
       round(avg((result->>'audio_seconds')::float8 / NULLIF(EXTRACT(EPOCH FROM finished_at - started_at),0))::numeric,2) AS rtf_avg
  FROM scribe_job WHERE kind='room_window' AND status='done' AND (result->>'silent_window') IS DISTINCT FROM 'true'
   AND result->>'audio_seconds' IS NOT NULL GROUP BY 1 ORDER BY 1 DESC;
```
Cap proposal: none yet (no data). Propose from the measured RTF after the first nights; the guard's in-flight rule already self-paces at LIMIT.
## Tests (own .bc/gate.log)
- Backfill file: 24 passed. Existing s1-auto-drain, e17 fairness unchanged and green.
- Gate: typecheck OK, typecheck:tests OK, vitest `Test Files 523 passed | 1 skipped (524)`, `Tests 10452 passed | 7 skipped (10459)`, build OK, check:silent "Found 9 silent-failure handler(s)" = the accepted 9, none in my files (gate=1 is that exit). swift build/test: N/A on Linux. First gate run had 1 failure (room-access allowlist for the new file), fixed, gate rerun clean. 0 new failures.
## Mutants (all killed)
live-first removed (1 fail); job-exclusion narrowed to queued/running (3); failure-rate guard off (2); limit clamp 5->9 (1); SINCE bound dropped (1); unset SINCE treated as on (2). Off-peak-edge mutant from the first draft is moot after the CHANGE.
## Assumptions / risks
- Added the in-flight guard (not in the brief) so 5-minute ticks cannot pile jobs on the Mini faster than it drains.
- A job in ANY state excludes a window from backfill, so a failed backfill job is not retried by it (per "no room_window job yet").
- UNVERIFIED live: the router's /healthz body is `{"ok": true}` per router_server.py source; not probed from here. If it ever returns another shape, backfill skips as router_unhealthy (fails safe).
- Guard thresholds are constants to tune after first RTF data. Backfill is bulk work: with ETA_ROUTER_BULK_URLS set it uses only that pool.
