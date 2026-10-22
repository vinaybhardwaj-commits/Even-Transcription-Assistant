# SPINE-0174-BUILD — seed spine_config ingest = shadow (migration 0174)
Branch spine/0174-ingest-shadow off origin/main (d6a9659d). Builder: Sonnet.

## Changed
- db/migrations/0174_spine_ingest_shadow.sql — header, BEGIN/COMMIT as 0173, `INSERT INTO spine_config ('ingest','"shadow"') ON CONFLICT (key) DO NOTHING`, schema_migrations (174,'0174_spine_ingest_shadow') ON CONFLICT DO NOTHING. No kill_switch/jobs/mode.* row.
- db/rollbacks/0174_spine_ingest_shadow.down.sql — deletes ingest only if value is "shadow"; deletes only its own schema_migrations row (version 174 AND name).
- tests/unit/spine-0174-pg.test.ts — 8 tests (postgres:16): seed + parseIngestMode=shadow, no other keys, double-apply no-op, operator "off" not overwritten (rollback leaves it too), rollback scope, foreign 174 row survives, runner-pattern discovery puts 0174 right after 0173 and unique.
- tests/unit/spine-ingest-realmig-pg.test.ts line 50 — ONE-LINE change outside the brief's list: its setup plain-INSERTed ingest='shadow' after applying all real migrations, which now collides with the seed (duplicate key). Added ON CONFLICT (key) DO NOTHING. Same end state.

## Tests (from .bc/gate.log, full run before the line-50 fix)
- Migration number: 0174 free on origin/main and every `git branch -r` ref.
- typecheck, typecheck:tests: green. Full vitest (--maxWorkers=4 --minWorkers=1): `Test Files  3 failed | 504 passed | 1 skipped (508)`, `Tests  2 failed | 10229 passed | 15 skipped (10246)`.
- The 3 failures: spine-ingest-realmig-pg (mine, fixed, see above; rerun with spine-0174-pg: `Test Files  2 passed (2)`, `Tests  16 passed (16)`), e11-silent-room-window and no-identity-literals (both fail identically on a clean origin/main worktree: `Test Files  2 failed (2)`, `Tests  2 failed | 25 passed (27)` = B29/B30). 0 new failures vs base.
- The vitest failure stopped the chained gate, so build and check:silent ran separately afterwards: `npm run build` exit 0. `npm run check:silent` exit 1 with findings only in app/ files this lane does not touch (pre-existing, accepted per repo notes). The full suite was NOT re-run in one piece after the line-50 fix; only the two spine files were rerun.
- swift build/test: N/A on Linux.

## Mutants
None run (SQL seed; test assertions cover DO NOTHING, rollback scope and value check directly).

## Assumptions
- BEGIN/COMMIT used because 0173 uses it. Rollback's value check ("shadow") means an operator-changed ingest value survives a rollback (per brief).
## Open risks
- Nothing applied to any DB. Once fable runs run-migrations, ingest = shadow takes effect on the next cron tick.
