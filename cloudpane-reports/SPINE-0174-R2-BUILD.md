# SPINE-0174-R2-BUILD
Lane spine-0174-r2, branch spine/0174-ingest-shadow (on top of 10854fae).
## Changed
- vercel.json: appended crons entry {"path":"/api/cron/spine","schedule":"*/5 * * * *"} (no duplicate, JSON valid).
- app/api/cron/spine/route.ts: header comment only; now says it is scheduled every 5 minutes and is a no-op unless spine_config ingest is shadow or live (kill_switch respected). No code change.
## Tests
- npm run typecheck: exit 0.
- vitest (--maxWorkers=4 --minWorkers=1) on 13 files referencing vercel.json/crons + spine-ingest* + spine-0174*: Test Files 18 passed (18), Tests 360 passed (360).
- No test allowlists cron paths; none needed editing. Full gate not run (per brief).
## Assumptions
- Comment says "every 5 minutes" rather than the literal cron string, because the literal contains `*/` which terminates a block comment (first attempt broke typecheck; fixed).
## Open risks
- Production behaviour once deployed depends on spine_config ingest value; default is off/shadow per 0174 seed.
