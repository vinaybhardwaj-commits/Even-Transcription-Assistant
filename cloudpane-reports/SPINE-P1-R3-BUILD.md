# SPINE-P1 R3 build — spine/p1-producers (on 1c2e7842; c3; no push of main, no PR)
## Changed
- F1 lib/spine/ingest.ts (acousticKey), ingest-store.ts, phi-screen.ts docs, tools/eta-spine/phi-rules.json (new id key + format `acoustic_key`, source_key_format acoustic -> acoustic_key), tests/fixtures/spine-phi-cases.json: acoustic source_key = `<room_day_id>:<epoch minute of start_ms, floor to 60 s, base 36>` (4-6 chars, no 7-digit run). run_id/hypothesis_id stay in attrs.ids. Same-bucket duplicates in one batch collapse to the first. TS and Python screens share the one JSON; both suites green.
- F3 route.ts, producers.ts: shadow-v3 removed from the cron (dep and counts timeline_ok/timeline_err gone; route header documents it). Acoustic + leave kept.
- F2 producers.ts `acousticDue`: acoustic only when the IST minute < 15 (24 runs/day). Leave every tick. New count `acoustic_due`.
- F4 producers.ts `rotateByTick`: list rotated left by floor(now/15 min) mod n.
- F5 producers.ts/route headers: actual order is acoustic (when due) then leave; voice.ts runs v3, leave, acoustic.
- Tests: ported tests/unit/spine-p1-oref-adv.test.ts and spine-p1-oref-pg.test.ts (adapted: no v3, due clock); new spine-p1-r3.test.ts (19); updated spine-p1-producers, spine-ingest, spine-ingest-realmig-pg, phi fixture.
## Proof (pg, postgres:16, all real migrations)
4 identical ticks x 2 room-days: acoustic spine_signal = 4 rows / 4 distinct keys, all rev 1 (R2 had 16). Moved end in the same bucket: rev 1,2 on the same key; start in another minute: new key rev 1. Timeline stays 2.
## Gate (.bc/gate.log, 4 workers, one run)
`Test Files  2 failed | 510 passed | 1 skipped (513)` / `Tests  2 failed | 10317 passed | 7 skipped (10326)`. The 2 failures (e11 sweep, no-identity-literals) are the base failures; 0 new. typecheck + typecheck:tests pass. Vitest exit 1 stopped the && chain, so I ran build and check:silent by hand: build exit 0; check:silent exit 1 with the same 9 accepted findings, none in P1 files. pytest tools/eta-spine/tests 298 passed. swift N/A on Linux.
Note: spine-queue and spine-s6-pg claim tests failed in an earlier gate and also at base in isolation, but passed in the final gate: flaky, not caused by R3.
## Mutants (9/9 killed)
row-id key (7 tests fail), store keyOf row id, v3 called again, acoustic every tick, due threshold 30, no rotation, constant rotation, ms-granular bucket, no batch dedupe.
## Assumptions / open risks
- Rotation is by tick index (offset moves 1 per tick, 4 per hour); acoustic uses one tick an hour, so with n sharing a factor with 4 and a small budget some rooms may miss an hour's acoustic run (next hour covers different offsets). Not guaranteed fair for every n.
- A room whose tick budget runs out misses that hour's acoustic run (no catch-up).
- The reader returns the latest run per room-day only; an interval a later run drops keeps its old signal (no tombstone), as before.
- Existing prod spine_signal acoustic rows keyed by hypothesis id (if any) stay; they will not match the new keys. Not applied anywhere (no DB touched).
- ENCOUNTER_TIMELINE_SHADOW prod value still UNVERIFIED. F3 is interim pending fable's ruling.
- Gate was started through the harness background mode (one process, one suite at a time).
