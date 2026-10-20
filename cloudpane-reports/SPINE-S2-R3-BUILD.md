# SPINE-S2-R3-BUILD (round 3: fixes from the Opus R2 refute; still pure merge, no writer)
Branch spine/s2-merge on top of 6cc19fd0.
## Changed
- lib/spine/merge.ts: X1 claimed priors are removed from losers, assertUniqueIds now runs after the loser rows. X2 pulse<->pqm merge by time only when overlap >= 50% of BOTH spans (key merges unchanged); pulse-anchored prior survives a pulse+pqm merge; same-kind strong priors still never survivor/loser. X3c `clamp_failed` flag. X4a a frozen prior never absorbs a live one (live candidate survives); X4b a frozen loser's signals keep their assignment. X5 strongOwner prefers the identity link over a stale id. X6c `ambiguous` for a consult_uid-only weak signal when the uid exists on >1 machine. Header documents each.
- lib/spine/types.ts: flags comment. tests: spine-merge-r3-oref.test.ts (refute X1-X6 as assertions + 3 mutant-driven fixtures), spine-merge-prop.test.ts (seeded, 3,000 pulse-only + 3,000 mixed room-days), spine-merge-oref.test.ts M3 edge test adapted to mutual 50% (pulse 0-10, pqm 5-15).
## Tests (own runs)
- `npx vitest run tests/unit/spine-merge tests/unit/evidence-spine`: Test Files 6 passed (6), Tests 124 passed (124). Property test: 0 violations in both modes.
- Gate (.bc/gate.log, .bc/gate2.log; 2 sequential foreground shards, 4 workers): typecheck + typecheck:tests ok; shard 1/2 `Tests 1 failed | 4523 passed (4524)`; shard 2/2 `Tests 1 failed | 4891 passed | 5 skipped (4897)`. The 2 failures (e11-silent-room-window, no-identity-literals) are the same two that fail at base e9f7e6a2 (R2 refute): new failures vs base = 0, none in spine.
- `npm run build` exit 0. `npm run check:silent` exit 1, the 9 accepted pre-existing findings, 0 in lib/spine. Swift N/A on Linux.
## Mutants: 25 run, 24 killed, 1 equivalent
Builder R2 14 (drop M4, 50->40, 120s->60s, 72h->48h, survivor newer, drop 8-digit, M16, M19, drop anchor-claim, drop uniqueness assert, drop clamp, drop frozen-link guard; plus 8-digit etc.): all killed. Refute survivors O1, O2, O11, O12, O14: all killed (O1, O11 by new fixtures). New: drop claimed-exclusion (3 tests, property), mutual->meets, pqm survives, drop clamp_failed, frozen absorbs, frozen loser assignment moves, drop X6c: all killed.
- SURVIVOR (equivalent): "assert before the losers" alone. With the claimed-exclusion in place no duplicate can reach the assert, so position is unobservable; with the exclusion dropped the property test already fails. Not killable by a fixture.
- I did not have the refute's other 9 O-mutants (O3-O10, O13) as code; only the 5 named in its report plus the builder's list were rerun.
## Assumptions
- X2: "mutual" applies to pulse-only vs pqm-only groups (cross-kind time pairs). A pulse+pqm merge that happens by key, or a group already holding both, is the same consult; there the pulse prior survives and the pqm prior becomes `merged`. The brief's "covered_by_pulse" test is a pqm similar in length to the pulse; a pqm much shorter than half a pulse no longer time-merges (interim safer rule).
- X4a: when a group has live and frozen candidates the live one survives; the frozen row is not emitted and its links/signal assignments stay.
- Existing oref M3 test changed (shorter-span 50% for pulse+pqm is superseded by X2).
## Open risks
- fable's rulings still pending for I3 clamp, A2 consult_uid machine, X2. Migration 0173 not needed this round.
