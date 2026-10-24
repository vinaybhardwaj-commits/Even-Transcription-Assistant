# SPINE S7a R2 build — spine/s7a-transcript-final (on 2a0628e5, no migration)
## Changed
- lib/spine/transcript-final.ts: covers(), istDateOf, takeOffers/newBudget (pass budget 2, 1 per room), rotate, REVISED_EVENT; Counts has no blind_excluded; decide() requires coverage, returns all offer candidates.
- lib/spine/transcript-final-store.ts: assess/evaluate, shared budget, blind count in pass tick only, reaper (this stage), revival (F6), revision sweep + recordRevision (F7), close-day blind check.
- lib/spine/transcript-final-read.ts: read-time blind filter (day + windows), cursor follows rows read.
- lib/room-access/readers/spine-transcript.ts: room.transcript_enabled join, both IST days, blindWindowsAny.
- lib/spine/jobs.ts: reapExhausted(stages?). app/api/spine/report/route.ts: 403 server_stage.
- tests: spine-s7a(.pg), spine-s7a-r2-adv-pg (A1-A9 adopted unchanged, A10/A11 updated to F6/F7), spine-queue (db mock), M20 scan regex, M19 clamp.
## Gate (own .bc/gate.log, 4 workers)
- typecheck, typecheck:tests clean; build OK.
- vitest: Test Files 532 passed | 1 skipped (533); Tests 10570 passed | 7 skipped (10577). 0 failures.
- check:silent: the 9 pre-existing findings, none in S7a files (gate= exit 1 is only this). swift: N/A on Linux.
- (First gate run had 2 failures, both mine, fixed: spine-queue db mock; a 300000 literal.)
## Mutants (7): 6 killed (report server_stage, reaper stage filter, per-room cap, coverage, revision guard, day-level blind). Survivor: F6 `!== ready` -> `=== fail` is equivalent (failed jobs are past deadline).
## Assumptions
- F6 revives only when the decision is ready (not via enqueue); bounded because the revived job ends done.
- F7 keyed on latest event's sha differing (allows A->B->A); detection by run-id set; same-run text edits undetected (UNVERIFIED, runs assumed immutable). Artefact stays create-only.
- F4 join drops all windows of a Transcript-off room (even already transcribed). Coverage tolerance 60 s.
## Open risks
- windows_not_ready failures count toward the stage breaker for 30 min (existing); revival waits it out.
- Real drainRoomWindow statement count still estimated, A12 budget test not adopted.
