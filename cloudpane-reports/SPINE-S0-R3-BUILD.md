# SPINE-S0-R3-BUILD (lane spine-s0-r3, branch spine/s0-schema, on top of R2)
## Changed
- db/migrations/0173_spine.sql: spine_encounter.flags text[] NOT NULL DEFAULT '{}', CHECK spine_encounter_flags_chk (flags <@ the 6 values), GIN spine_encounter_flags_idx (IF NOT EXISTS). Header lists the emitting merge.ts lines (origin/spine/s2-merge): multi_machine :332, pulse_overlap :336-337, clamped :319, clamp_failed :322, ambiguous :326, plus covered_by_pulse (S2 R4, not emitted yet). Rollback unchanged (drops the table, index goes with it).
- tests/unit/spine-schema-pg.test.ts: new flags test (default '{}', each flag, all six together, unknown / wrong-case / NULL element / NULL array refused, 10k-row EXPLAIN uses the GIN index). Existing idempotent-twice, rollback and foreign-173 tests cover the rest.
## Tests
- spine-schema-pg: "Tests  13 passed (13)".
- Mutants (spine-schema-pg): drop CHECK -> "1 failed" killed; drop covered_by_pulse from CHECK -> "1 failed" killed; drop DEFAULT -> "6 failed" killed; drop GIN index -> "1 failed" killed.
- Full gate (.bc/gate.log, `--minWorkers=1 --maxWorkers=4`): "Test Files  2 failed | 449 passed | 1 skipped (452)", "Tests  2 failed | 9342 passed | 5 skipped (9349)", gate=1. Both failures are outside this diff: e11-silent-room-window (Whisper call-site sweep, 41 vs 34) and no-identity-literals (offenders only in tools/eta-consult-steward/tests and tools/ubus/test). Not rerun at base; offender paths are untouched files.
- Because vitest failed, `&&` skipped the rest; run separately: npm run build exit 0; npm run check:silent exit 1 (findings only in app/ files I did not touch, pre-existing). typecheck and typecheck:tests passed. swift: N/A on Linux.
## Assumptions / risks
- FINDING: the brief says `'ambiguous' = ANY(flags)` should use the index. A GIN on text[] cannot serve `= ANY(flags)`: measured Seq Scan. The index serves `flags @> ARRAY['ambiguous']` (and &&). Test asserts the @> form; migration header tells readers to use @>. S2/S4 readers must not use = ANY. If = ANY is required, a btree/expression approach is a design change for fable.
- Planner picks the GIN index only for rare flags (1 in 1000 at 10k rows; 1 in 100 chose Seq Scan), so the index test seeds 10 flagged rows.
- `npx vitest run --maxWorkers=4` alone throws "minThreads and maxThreads must not conflict" in this env; used --minWorkers=1 as well.
- No existing row/consumer needed a backfill (0173 not merged).
