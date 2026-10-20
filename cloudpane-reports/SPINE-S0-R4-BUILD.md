# SPINE-S0-R4-BUILD (lane spine-s0-r4, branch spine/s0-schema, on top of 19f3ae78)
## Changed
- db/migrations/0173_spine.sql: flags CHECK now = ambiguous, multi_machine, pulse_overlap, clamped, clamp_failed, covered_by_pulse, frozen, enc_conflict, AND (array_ndims(flags) IS NULL OR array_ndims(flags) = 1). spine_link key_kind CHECK adds pulse_enc_id. Header rewritten against origin/spine/s2-merge 83c41733 (lines in the file, which differ from the R3 header, now corrected): clamped :352, clamp_failed :355, ambiguous :359, multi_machine :365/:367, covered_by_pulse :374, pulse_overlap :379/:380, frozen :485 (alias `fl`, sorted into flags[] at :489/:507). Passthrough :524 is [].
- tests/unit/spine-schema-pg.test.ts: allowed list adds frozen and enc_conflict; '{{ambiguous}}' and a 2-row nested array refused; pulse_enc_id link accepted; the 10k-row seed is DELETEd after the plan check.
## Tests
- spine-schema-pg: "Tests  13 passed (13)".
- Mutants (11, each "1 failed" or more, all killed): drop frozen, drop enc_conflict, drop 1-D check, drop covered_by_pulse, drop ambiguous, drop flags CHECK, drop DEFAULT ("6 failed"), flags nullable, drop GIN, GIN->btree, drop pulse_enc_id kind. The R2 mutants used the refuter's oref test, which is not in the repo, so they were not rerun; R3's four flag mutants are covered above.
- Full gate (.bc/gate.log, --minWorkers=1 --maxWorkers=4): "Test Files  2 failed | 449 passed | 1 skipped (452)", "Tests  2 failed | 9342 passed | 5 skipped (9349)", gate=1. Same two failures as R3, outside this diff: e11-silent-room-window and no-identity-literals. typecheck and typecheck:tests passed (the chain reached vitest). npm run build exit 0. check:silent exit 1, findings in app/ files, none touched. swift: N/A on Linux.
## Assumptions / risks
- enc_conflict is not emitted by merge.ts at 83c41733 (S2 R5 pending); added per the ruling. Re-grep when S2 R5 lands.
- 0173 is free on origin/main; other spine branches carry their own 0173_spine.sql (same file), oauth branches carry 0173_mcp_blacklist_applied (gating-lead owns numbering).
