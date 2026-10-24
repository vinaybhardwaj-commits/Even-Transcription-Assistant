# SPINE-S6SCOPE-BUILD — per-room scoping of live stages (S6 gap G1)
Branch spine/s6scope-rooms (off abf4e89e). No migration. Opus refute follows.
## What changed
- lib/spine/config.ts: THE ROOM RULE (header comment states it exactly): `parseRoomScope`, `roomMode`, `effectiveRoomMode`, `claimRules`, `ruleAllows`, `readRoomMode`; `modesFrom/readModes` also return `scopes`.
- lib/spine/enqueue.ts + enqueue-store.ts: planned status via effectiveRoomMode; SELECT_SQL reads room_id (EncounterRow.room_id optional; legacy 3-arg planJobs unchanged).
- app/api/spine/claim/route.ts + lib/spine/jobs.ts claimJobs(…, rules): the claim takes only rooms the rule calls live (would_run: shadow); SQL tests the encounter's room. Response `mode` = the claim kind.
- app/api/spine/report/route.ts + reportJob: the shadow->release check (N3) is room-aware (`modeOf(stage, encounter_id)`).
- tests: spine-s6scope.test.ts (pure, 16), spine-s6scope-pg.test.ts (postgres:16, 6), spine-queue.test.ts (mock gains `scopes`, modesFrom expectations gain `scopes`).
## Rule
`mode.<stage>` = "live" | {"mode":"live"} -> all rooms (unchanged). {"mode":"live","rooms":[..]}: listed -> live, others (and unknown room) -> shadow. {"mode":"shadow","rooms":[..]}: listed -> shadow, others -> off. A `rooms` key that is not an array of non-empty strings = EMPTY list (live for no room, never all). jobs cap, kill_switch, paid/unknown-stage ban apply on top, unchanged.
## Room moved in/out
Nothing deleted. A queued row of a room taken out stays queued; a live claim skips it (claim-time check), a would_run claim takes it as shadow and its shadow report consumes it (not bounced to queued). A room put back: its shadow rows revive to queued by the existing ON CONFLICT rule on the next enqueue pass; queued rows are claimable at once. Tested.
## Runbook: flip sequence per room (adds to SPINE-S6LIVE-RUNBOOK §3 step (c))
1. jobs=live, kill_switch=false, runner running with --live. `mode.recut` = {"mode":"live","rooms":["<one room_id>"]} (acoustics/nemotron stay shadow).
2. Watch counts only: `SELECT status, count(*) FROM spine_job WHERE stage='recut' GROUP BY 1` (queued falls; leased <= 1 per runner), `spine_artefact` rows (store='box') = done jobs, failed/dead by last_error_code. The first enqueue pass queues only that room's closed encounters in the 72 h horizon; every other room is `shadow`.
3. After ~5 clean recuts add the next room_id to the list; then acoustics, nemotron the same way. Remove a room = delete it from the list (config upsert); in-flight job finishes (G5), nothing new is claimed live for it.
4. Plain "live" is still valid but means all rooms: use the room list.
## Gate (.bc/gate.log)
typecheck + typecheck:tests: clean. vitest (.bc/gate.log, 4 workers): "Test Files  1 failed | 529 passed | 1 skipped (533)", "Tests  1 failed | 10489 passed | 7 skipped (10537)". The 1 failure is tests/unit/s1-auto-drain.test.ts R11 (a planner-choice assertion; Nested Loop picked under load), unrelated to this diff, and that file passes alone ("Tests  59 passed (59)"): 0 new failures from this lane. (A first gate had 1 failure in my own new pg test, a stale cut_version on a control row; fixed, gate rerun.) build run separately after vitest stopped the chain: exit 0. check:silent: 9 findings, the accepted pre-existing ones, none in files touched. Gate was run via the harness background (the 600 s tool cap), one suite at a time, nothing else ran in this worktree meanwhile.
## Mutants (pure + pg files, 22 tests; all killed; M5/M6/M10 rerun after the test fix: 2/2/3 fail)
M1 malformed rooms -> all (3 fail), M2 unlisted keeps mode (10), M3 shadow-unlisted -> shadow (4), M4 claim negate lost (4), M5 SQL negate (3), M6 report route room-blind (3), M7 jobs=off cap removed (3), M8 live claim ignores jobs (2), M9 planner ignores room (5), M10 SQL ignores room (3).
## Assumptions / open
- Would_run claim of a stage declared live with jobs=shadow and a room list takes unlisted rooms only (an unscoped live stage under jobs=shadow is still taken by nothing, as before).
- `jobs.enqueue()` (F4 helper, no production caller) still reads the stage mode room-blind; unused, left.
- readRoomMode (report) ignores the jobs cap, as readMode did.
- transcript_final (S7a) is not on this base; it must call roomMode/claimRules from config.ts when it lands.
- Host-local: none. Swift build/test N/A on Linux.
