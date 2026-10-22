# SPINE-P1 build — producer cron (branch spine/p1-producers, host c3)
## Changed
- app/api/cron/encounter-shadow/route.ts (new): GET, CRON_SECRET bearer via lib/spine/auth, gated by spine_config `producers`, counts-only JSON, maxDuration 60.
- lib/spine/producers.ts (new, pure, clock injected): runProducers + parseMax. Bounds: SPINE_PRODUCERS_MAX (default 12, bad value -> 12), no new room-day after 45 s.
- lib/spine/config.ts: parseProducersMode (same rules as parseIngestMode, key `producers`).
- lib/room-access/room-days-for-date.ts (new): listRoomDaysForDate (room SQL stays in lib/room-access).
- vercel.json: /api/cron/encounter-shadow, */15 * * * * (own commit). Migration 0175 + rollback (own commit; 0175 free on origin/main and all remote branches).
- Tests: tests/unit/spine-p1-producers.test.ts (26), tests/unit/spine-0175-pg.test.ts (8, postgres:16).
## Gate (.bc/gate.log, 4 workers, foreground)
- typecheck, typecheck:tests: pass. vitest: `Test Files  3 failed | 506 passed | 1 skipped (510)`, `Tests  3 failed | 10273 passed | 7 skipped (10283)`; gate=1 from vitest, so build/check:silent were run separately.
- Failures: e11-silent-room-window (base), no-identity-literals (base; only tools/eta-consult-steward and tools/ubus files), spine-queue "claim ... live=true narrows" — NOT in the brief's base list, but it fails identically with my changes stashed (re-run at base: 1 failed | 13 passed). 0 new failures.
- npm run build: exit 0. check:silent: 9 findings, pre-existing, none in my files. swift build/test: N/A on Linux.
## Producer behaviour vs voice.ts
- Same args to runShadowForRoomDay; blind check = isBlindRoomDay(date, room) || roomDayIsBlind(id), run before any runner; a failing blind check fails closed (counted blind_skipped).
- Timeline: only when encounterTimelineShadowEnabled(); gate_diar from encounterGateDiarEnabled(). A throwing flag (either) -> timeline skipped, timeline_flag_invalid=1, acoustic still runs. The MCP tool's runTimelineLeaveForRoomDay is NOT called (not in the brief).
## ACTION FOR FABLE
- Set ENCOUNTER_TIMELINE_SHADOW in Vercel prod to a FLAG_TRUTHY value: `1`, `true`, `yes` or `on` (case-insensitive, trimmed). Prod value UNVERIFIED. Env is baked at build: redeploy after. Any other non-falsy value (e.g. `enabled`) makes timeline_flag_invalid=1.
## Not done / UNVERIFIED
- Real-runner pg test skipped: no existing fixture runs runShadowForRoomDay end to end on a synthetic day (tests mock its inputs).
- Cost per runner call NOT measured (no shared DB allowed). Each call re-reads the day's evidence and appends a run; the timeline run also calls Jev. 12 room-days x 2 runners per 15 min is the worst case.
- A room-day that exists but has no recorded audio returns no_recorded_audio each tick: counted as acoustic_err, a normal class.
## Assumptions
- "shadow" and "live" behave identically (both producers write only their own shadow tables).
- Room-day list = all room_day rows for IST today, ordered by room_id, id.
