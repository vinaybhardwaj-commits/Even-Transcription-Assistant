# SPINE-S4B-BUILD — Encounter Explorer data routes (read-only, shadow)
Branch spine/s4b-explorer off origin/main e446eb84. No migration (0173 from S0 is the schema). No existing file edited.

## Changed (all new)
- lib/spine/explorer-read.ts — SELECT-only reads, `explorer` flag parser, param parsers, pure `foldDay`.
- lib/spine/explorer-route.ts — shared guard: `requireAdminBearer` (catalog helper, reused) then spine_config `explorer`.
- app/api/spine/explorer/day/route.ts, encounters/route.ts, encounter/[encounter_id]/route.ts.
- tests/unit/spine-explorer-routes.test.ts (15), tests/unit/spine-explorer-pg.test.ts (6, postgres:16 + real 0173).

## Tests (own .bc/gate.log, 4 workers, foreground)
- typecheck, typecheck:tests: pass. `Test Files  2 failed | 489 passed | 1 skipped (492)`, `Tests  2 failed | 10034 passed | 7 skipped (10043)`, gate=1.
- The 2 failures are NOT mine, same two the buglog commit 19711485 names (B29/B30): e11-silent-room-window (Whisper sweep count) and no-identity-literals (tools/eta-consult-steward/tests, tools/ubus/test). My files appear in neither.
- The `&&` chain stopped at vitest, so I ran the rest by hand: `npm run build` exit 0. `npm run check:silent` exit 1 with findings in app/[slug]/... only; none in app/api/spine/explorer or lib/spine (pre-existing set, not fixed).
- swift build / swift test: N/A on Linux.
- Mutants, both KILLED: signals `count(DISTINCT source_key)` -> `count(*)` (pg test 1 failed); drop `shadow` from the flag parser (routes test 1 failed). Also caught while building: job "latest status" without superseded-last ordering (killed by the fixture).

## Contract as built
- Auth: 401 with no/wrong bearer, unset ADMIN_TOKEN, or any `token` query param (any case). Flag missing/off/malformed/unreadable: 404 `not_found`. Auth is checked first.
- day: rooms[] (sorted, null room last) each with encounters{candidate,confirmed,rejected,merged,total}, flags{ambiguous,multi_machine,pulse_overlap}, signals_by_proxy (all 8 proxies), jobs_by_stage{stage:{7 statuses, oldest_queued_age_s}}. Empty tables: `rooms: []`; with room_id, that room with zeros.
- encounters: keyset page, oldest first, limit 1..200 (default 100), `flag=` filter via `flags @> ARRAY[..]`; also status, room_id, cursor. Rows carry flags, proxies_seen, jobs (stage -> latest status), artefact_count.
- encounter/<id>: row (with merged_into), links, signals (+close_reason only), jobs, artefacts. Unknown id 404; malformed id 400.

## Assumptions
- Flag `explorer` is on for true, "on", "shadow", {on:true}, {mode:"on"|"shadow"} (also as JSON text). Everything else is off.
- ist_date below IST_FLOOR (2026-09-09, imported from the catalog) is 400 `before_floor`.
- Signals on the day view: the IST date of t_open, count of distinct source_key per proxy (revs are one signal). Jobs follow their encounter's ist_date and room. Oldest queued age = server now minus min(created_at) of queued jobs.
- Per-stage "latest" job status = newest job_id, a superseded job only if no other exists. Extra read-only fields on rows: ist_date, boundary_rev, merge_version, reason, created_at, updated_at.
- No S4B-CONTRACT.md existed on c3; the brief's shapes were used.

## Open risks
- UNVERIFIED against Neon: bigint counts are cast to int in SQL; text[] arrays are decoded by `arr()` for both array and `{a,b}` forms.
- Day-view signals scan spine_signal by IST date of t_open (no index on that expression); fine at current volume, check when the table grows.
