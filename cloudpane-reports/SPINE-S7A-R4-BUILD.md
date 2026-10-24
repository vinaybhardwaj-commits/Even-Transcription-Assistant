# SPINE-S7A-R4-BUILD (branch spine/s7a-transcript-final, on e38ad691; no migration)
Fix I2b (held-out leak via revises_sha256).
## Changed
- lib/spine/transcript-final-read.ts: readFinalEvents now looks up each served revision's predecessor in storage (same kind, same encounter, by text.sha256), applies the same read-time filter (blind day, blind covering windows), and omits revises_sha256 from the served event when the predecessor is hidden or absent. Storage is untouched (append-only).
- tests/unit/spine-s7a-r4-adv-pg.test.ts: refuter's C1-C9 adopted (one TS cast added at the `failed` count for typecheck:tests) + 3 chain cases (A->B->C none hidden; only A hidden; B hidden), INSERT-only.
## Tests
- S7a + room-access-gate targeted: 6 files, "Tests 107 passed (107)"; r4 file alone: "Tests 12 passed (12)" (C3 now PASS; A1-A12/B1-B13 files green).
- Gate (.bc/gate.log): typecheck ok, typecheck:tests ok, "Test Files 534 passed | 1 skipped (535)", "Tests 10597 passed | 7 skipped (10604)", build "Compiled successfully", check:silent 9 findings (the accepted pre-existing 9) -> gate=1 from check:silent only. 0 new failures.
- swift build/test: N/A on Linux. Mutants: none run. C3 FAIL->PASS was not re-demonstrated against the pre-fix code (passes with the fix).
## Assumptions
- Brief says serve "revises_sha256 = null"; the refuter's dangling check counts any non-undefined value not in the served set, so null would fail C3. I OMIT the field (same as a non-revision event). Fable may rule otherwise.
- Predecessor match is by (encounter_id, text.sha256) within the same kind.
## Open risks
- Predecessor lookup is one extra query per read page, only when a served event is a revision.
