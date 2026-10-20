# SPINE-S0-BUILD — Spine S0 schema (branch spine/s0-schema)
HOLD for fable (migration). Not applied to Neon or any shared DB.

## Changed
- db/migrations/0173_spine.sql: spine_signal, spine_encounter, spine_link, spine_artefact, spine_job, spine_config, spine_tick (7 tables; the brief says "6" but lists 7). CREATE ... IF NOT EXISTS, registers schema_migrations 173, no seed rows, no ALTER of existing tables.
- db/rollbacks/0173_spine.down.sql: drops all 7 + schema_migrations row.
- tests/unit/spine-schema-pg.test.ts: 9 tests on postgres:16.
- db/schema.ts: unchanged (it does not register 0168/0169).

## Tests
- `npx vitest run tests/unit/spine-schema-pg.test.ts`: "Tests  9 passed (9)".
- Mutants (each run, reverted): drop 'merged' from status CHECK -> 1 failed; drop partial-unique WHERE -> 1 failed; drop IF NOT EXISTS (spine_tick) -> 1 failed; drop the spine_job DROP from rollback -> 1 failed. All killed.
- Full gate (.bc/gate.log, 4 workers; `--minWorkers=1` was needed or vitest threw "minThreads and maxThreads must not conflict"): "Test Files  2 failed | 449 passed | 1 skipped (452)", "Tests  2 failed | 9338 passed | 5 skipped (9345)". Both failures are pre-existing: e11-silent-room-window (Whisper site sweep) and no-identity-literals (tools/eta-consult-steward conftest etc.); both also fail on a clean worktree of the base commit. Neither touches this slice.
- typecheck, typecheck:tests: green (gate passed them). Because vitest failed, build and check:silent ran separately: `npm run build` exit 0; `check:silent` "Found 9 silent-failure handler(s)" = the 9 accepted.
- swift build/test: N/A on Linux.

## Assumptions
- 0173 used per gating-lead; origin/oauth-email-squashed and origin/scribe/oauth-email-code also carry 0173_mcp_blacklist_applied.sql.
- Column types for unspecified columns are mine: job_id/id bigserial; spine_artefact gets surrogate id PK; spine_link has no PK (partial unique only); text for stage/engine/version/cfg8/cut_version; merge_version NOT NULL.
- FKs: spine_link/artefact/job -> spine_encounter. spine_signal.encounter_id and merged_into have no FK (kept loose on purpose).
- spine_signal.attrs CHECK limits top-level keys to ids, quality, close_reason (plan: "allowlist of ids/quality/close_reason only"); S1 widening needs a migration.
- spine_encounter.status has no default. encounter_id regex ^enc_[a-z2-7]{16}$ plus no 8-digit run.
- Asus draft (.bc/asus-draft) NOT reused; I wrote everything fresh. Its attrs CHECK only required an object and it FK'd signal.encounter_id; I did not copy either.

## Open risks
- 2 pre-existing vitest failures above (base also red).
- The gate's first-line mention of 6 tables vs 7 listed: confirm 7 is intended.
