# SPINE-S3-BUILD — artefact index, read-only (branch spine/s3-artefacts)
Base: origin/spine/s0-schema + merge of origin/spine/s2-merge. Migration and merge.ts untouched. No new migration.

## Changed
- lib/spine/artefacts.ts: pure mapping (mapRow, planArtefacts, parseArtefactsMode), per-source SELECTs, INSERT_SQL.
- lib/spine/artefacts-store.ts: indexSpineArtefacts(now, db?) gated on spine_config `artefacts` (off/shadow/on; missing or malformed = off, off runs only the config lookup; shadow counts, writes nothing).
- tests/unit/spine-artefacts-pg.test.ts: 14 tests, postgres:16, sources built from 0135, 0140, 0150, 0157, 0168, 0169 + 0173.

## Behaviour
Placement only via active spine_link (consult_uid or window_id). No link = orphan, counted by source_table. Sha conflict on the unique key counted, never overwritten (INSERT ... ON CONFLICT DO NOTHING). Only write: INSERT INTO spine_artefact. Selects ids/keys/shas/statuses only; never prescription_uid, individual_uid, turns_json, names, artifact bodies, validator_errors.

## Tests (own .bc/gate.log)
- spine-artefacts-pg: "Tests 14 passed (14)".
- Full vitest: "Test Files 2 failed | 450 passed | 1 skipped (454)", "Tests 2 failed | 9354 passed | 5 skipped (9394)". The 2 fails (e11-silent-room-window, no-identity-literals) are identical at base HEAD (rerun there: 2 failed | 25 passed); not in my files.
- typecheck, typecheck:tests: pass. npm run build: exit 0 (run separately, since the && chain stopped at vitest).
- check:silent: 9 findings, the accepted pre-existing ones, none in lib/spine.
- swift build/test: N/A on Linux.

## Mutants (all killed)
1. Time-match orphans into an overlapping encounter: 5 tests fail.
2. Overwrite on sha conflict (DO UPDATE + insert on conflict): 2 fail.
3. Select a text column (turns_json): 2 fail.
(First attempt at 1 survived because the fixture times were in 2025; fixed, then killed.)

## Assumptions
- vitest 2.1.9 rejects bare --maxWorkers=4; used --maxWorkers=4 --minWorkers=1.
- consult_key unused: no source table carries it. bucket is NULL (no source records one).
- Row-to-key choices: cfg8 "none" where no config; sarvam engine = sarvam_<mode>[_en], cfg8 = hash of mode/english/pipeline_rev; reb shadow rows engine "<e>:shadow"; cut_version "window" for window sources; freescript object_key freescript_run/<id>, cfg8 = input sha prefix; catalog clip/layers via json key r2_key, status absent = ok, unknown status = unmapped (counted).
- Full-table scans each run (no cursor); fine at current sizes, UNVERIFIED on production row counts.
- Nemotron windows join only via window_id links; unlinked ones stay orphans (plan R6e).
