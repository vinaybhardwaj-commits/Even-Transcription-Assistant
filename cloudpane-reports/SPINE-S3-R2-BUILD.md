# SPINE-S3-R2-BUILD (lane spine-s3-r2, branch spine/s3-artefacts)
Merged first: origin/spine/s0-schema (S0 R2) and origin/spine/s2-merge (S2 R2). Neither edited. 0173 unique key unchanged.

## Changed
- lib/spine/artefacts.ts, artefacts-store.ts: F1-F5, mode words, cursor. Key derivation table is in the artefacts.ts header.
- F1/F2: reb and nemotron put `window:<window_id>` in cut_version; consult_index, sarvam, freescript, catalog put consult_uid (catalog also layer+key) in cfg8. A null sha never equals a null sha: object_key decides, a mismatch is a conflict.
- F3: EXISTING_SQL reads every artefact of the page's encounters (any source_table incl. object_key); a held key from another source_table is `foreign_conflict`.
- F4: every source SELECT has ORDER BY pk (COLLATE "C"); the plan also sorts candidates canonically, so shuffled input gives the same set.
- F5: catalog rows already indexed from consult_index (same consult) or reb (window with active link) are `dup_source`; catalog uses clip.sha256.
- Modes: exactly off|shadow|live; "on" is off. Header comment fixed.
- Cursor: spine_config `artefacts_cursor` {source: last_pk}, ROW_LIMIT 2000 per source per run, written only in live after the inserts. A source that runs out of rows resets to "" so the next run re-sweeps (picks up late-linked rows; idempotent).
- tests/unit/spine-artefacts-r2.test.ts (new: the 7 ported refute tests + null-sha, M8 no-artifact, catalog dedupe/sha, 5000-row cursor, order, foreign); spine-artefacts-pg.test.ts updated for the new keys/modes.
- tests/support/room-access-allowlist.ts: ONE pinned entry (`lib/spine/artefacts.ts`, max 1). The catalog dup probe names reb_track_index, which room-access-gate flags. FABLE TO RULE; fallback if refused is code-side dedupe against spine_artefact (order-dependent across pages).

## Tests (from .bc/gate.log)
- typecheck, typecheck:tests: pass. build: "Compiled successfully". check:silent: 9 findings (the accepted ones, none in lib/spine).
- vitest: "Test Files  2 failed | 454 passed | 1 skipped (457)", "Tests  2 failed | 9436 passed | 5 skipped (9443)". The 2 failures (e11-silent-room-window, no-identity-literals) are the pre-existing ones the refuter reproduced at base bf998832.
- spine-artefacts-r2 + spine-artefacts-pg: 30 passed. swift: N/A on Linux.

## Mutants (all on the two spine-artefacts test files)
Killed: window_id dropped (reb), window_id dropped (nemotron), null==null, no ORDER BY, cursor `>=`, cursor off-by-one (prev row), foreign counted as unchanged, dup_source off, "on" accepted, M8 (has_artifact ignored), uid dropped from sarvam cfg8, uid dropped from consult_index cfg8, EXISTING scoped by source_table, no canonical sort, catalog sha dropped. M14 (window join also accepting consult_uid links) stays the documented equivalent; the refute's other mutants M1-M13 are covered by the unchanged builder suite (re-run green).

## Assumptions / risks
- freescript: same consult_uid + same input_sha256 cannot occur (table UNIQUE), so run id is not in the key.
- Shadow reads the first page only and never persists a cursor, so shadow counts cover at most 2000 rows per source.
- Catalog dup probe is a per-row EXISTS (clip_r2_key and reb r2_key are not indexed); fine at 2000 rows/page, UNMEASURED on the real tables.
- The refute's Neon HTTP response-size estimate was never checked; the page cap bounds it to 2000 rows per source.
