# SPINE-S2-R5-BUILD (lane spine-s2-r5, branch spine/s2-merge, on 83c41733). Host c3.
## Changed
- lib/spine/merge.ts, types.ts: (A) an enc-joined pulse group (>1 consult_key) retires its other pulse priors as merged_into the survivor. (B) `encGuard`: a shared pulse_enc_id overrides a same-kind conflict / keys a merge only in one room, spans overlapping or <= 2 min apart, and (pulse pair: DIFFERENT machines; pulse+pqm; never pqm+pqm, and it must settle EVERY same-kind conflict, so a pulse cannot bridge two pqm). Otherwise no merge and both encounters get `enc_conflict`. (C) a NEW strong group on a past-horizon day is held: no encounter_id, no assignment, no link, counted in `MergeResult.held_frozen`.
- tests: spine-merge-prop4 + fix4 ported from .bc/oref-r4; spine-merge-r5 (14 tests, new); spine-merge-r4 updated (far-apart enc merges now stay apart; M13 now expects the loser merged_into).
## Gate (my .bc/gate.log, 2 shards not needed)
- typecheck, typecheck:tests: exit 0. vitest --maxWorkers=4: `Test Files  2 failed | 459 passed | 1 skipped (462)`, `Tests  2 failed | 9477 passed | 5 skipped (9484)`. The 2 failures are the base ones (e11 sweep; no-identity-literals, 19 items in tools/eta-consult-steward, none in spine).
- npm run build: exit 0. check:silent: 9 findings, none in spine (the accepted 9). Swift N/A on Linux. spine-merge*: `Test Files 11 passed`, `Tests 149 passed`.
## prop4 (5,000 days x 3 seed sets x pulse/mixed, 3 reruns)
- CENC 0: 0 violations in all 6 runs (V12 was 3,371). CENC 1% and 3%: 0 violations in all 12 runs.
- Joined patient pairs (final run, three sets): unguarded R4 866/788 at 1% and 2,534/2,281 at 3% (refuter). Now pulse-only 87/77/70 at 1%, 224/248/217 at 3%; mixed 78/81/69 and 250/225/220. All carry multi_machine (or enc_conflict). Unflagged (no flag at all): pulse 0; mixed 1/0/0 at 1%, 1/0/1 at 3%. I traced the 1% one: a pqm and a pulse that also overlap mutually in time, so a time capture that merges with no enc id (pre-existing), not an enc join.
- Genuine 2-machine splits at CENC 0 (V11): 0. Fixed point, shuffle, determinism: 0 V8.
## Mutants (K1-K16 + 13 new, /tmp/spine-s2-r5-mut/out.log; merge.ts sha256 verified restored)
- 24/29 killed at first pass, K10 and R7 redone (K10 killed by a new test; R7 was an ineffective mutation, R7b killed). Orphan fix dropped, guard dropped, machine check dropped, gap dropped, K16 and K8 killed.
- Survivors, equivalent: K1 (ownsPrior counts merged: links leave merged rows), K14 (sharesEnc any key kind: namespaces differ), R6 (room check in encGuard: both callers are already same-room).
## Assumptions
- Machine = text after the last `@` in consult_key; none -> cannot prove a second machine -> no merge.
- Held group: nothing is emitted, so `frozen` is not a flag on a row; it is counted in held_frozen (the ruling's "flag frozen on the held group's output" has no row to carry it). Hold applies to groups holding a pulse or pqm only; weak groups still mint.
- Extra flag, not in the ruling: `enc_conflict` also on a group merged on an enc id when time alone (pulse+pqm mutual 50%, else D8) would not have merged it, so enc joins of adjacent consults are not silent. Prior-independent, so it is a fixed point.
- Harness changes in prop4 (the refuter file): V4/V5/V3/V10 caused by a corrupt enc id are tolerated only when every encounter touched carries multi_machine or enc_conflict (else counted violation); a pqm whose captured home was retired may return to its own pulse or stand alone with covered_by_pulse; a pulse joining its own other machine's encounter is not V4 when another consult's pqm rides along.
## Open risks
- Residual corrupt-enc joins of adjacent consults on different machines within 2 min are indistinguishable from a real second machine: flagged multi_machine (+ enc_conflict when time-alone would not join), NOT prevented. Writer should hold paid work on enc_conflict.
- S0 R4: add `enc_conflict` to the flags CHECK (with frozen and the pulse_enc_id key_kind). MergeResult gains held_frozen (S7 must read it).
- Nothing outside lib/spine imports the merge; no flag, no migration.
