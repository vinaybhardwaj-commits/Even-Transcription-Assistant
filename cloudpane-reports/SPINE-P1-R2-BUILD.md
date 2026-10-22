# SPINE-P1 R2 build — leave runner added to the producer cron (branch spine/p1-producers, host c3)
## Why
encounter_timeline_shadow is written by runTimelineLeaveForRoomDay, not by shadow-v3 (R1 brief error). Without it the spine's timeline proxy read 0.
## Changed
- lib/spine/producers.ts: new dep `leave`; when the timeline flag is on, per non-blind room-day: acoustic, then v3, then leave (voice.ts order), same args (room_id, room_day_id, ist_date, gate_diar). A leave throw/failure is counted `leave_err` (class `leave_err` or `leave:<code>`), and stops nothing. Counts leave_ok / leave_err added.
- app/api/cron/encounter-shadow/route.ts: wires runTimelineLeaveForRoomDay; header names the tables.
- Runner -> table: runShadowForRoomDay -> encounter_hypothesis(_run) (spine proxy acoustic); runTimelineShadowForRoomDay (shadow-v3) -> encounter_hypothesis(_run) with source 'timeline' (via writeHypothesisRun); runTimelineLeaveForRoomDay -> encounter_timeline_shadow(_run) (spine proxy timeline).
- tests/unit/spine-p1-producers.test.ts: 29 tests (+3: leave args/order, leave throw/failure isolation, blind day no leave; flag-off/invalid assert no leave).
## Gate (.bc/gate.log, 4 workers, foreground)
- Targeted: spine-p1-producers + spine-0175-pg: `Tests  37 passed (37)`.
- typecheck, typecheck:tests: pass. vitest: `Test Files  3 failed | 506 passed | 1 skipped (510)`, `Tests  3 failed | 10276 passed | 7 skipped (10286)`. Same 3 failures as R1 (e11-silent-room-window, no-identity-literals, spine-s6-pg claim live=true); all fail at base. 0 new.
- npm run build: exit 0. check:silent: exit 1 on pre-existing findings, none in my files (listing in .bc/silent.log). swift: N/A on Linux.
## Open
- Cost: leave runner adds a third evidence read per room-day per tick (and Jev calls); unmeasured (no shared DB). ENCOUNTER_TIMELINE_SHADOW in prod still UNVERIFIED (see R1 report).
