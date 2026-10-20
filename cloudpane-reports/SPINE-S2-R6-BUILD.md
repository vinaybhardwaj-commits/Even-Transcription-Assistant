# SPINE S2 R6 BUILD (spine/s2-merge-r6 off origin/main d37c554e, which has S2 R5 = PR #183)
No flag, migration or store change. Shadow only; lib/spine/merge.ts + types.ts + tests.
## Changed
- lib/spine/merge.ts: (1) G1 `encGuard` rejects when the groups would hold two pulses of different consults (consult_key) on ONE machine, or with a machine that cannot be proven on EITHER side (the refute's scratch fix, reviewed; I made the null check symmetric). (2) `MergeResult.held: string[][]` = source_keys per held group (sorted); `held_frozen === held.length`; held signals get no assignment and no link. (3) F1: on a frozen day a strong signal with no frozen home of its own that shares no identity key with a member that has one is held (both the cand-empty and the frozen-survivor path); the home-bearer keeps its home. (4) V5: a pqm-only group whose prior home equals a pulse home in an enc-joined pulse group (>1 consult_key), and that group holds the pqm's span best (strict, no tie), rides with that group (no new covered_by_pulse row).
- lib/spine/types.ts: `held`. Tests: spine-merge-r6.test.ts (15), spine-merge-r6-adv.test.ts (refute's adv5, G1+F1 it.fails now pass).
## Tests (own runs)
- spine-merge* (13 files incl. prop3, prop4, r6): all green; refute adv5 13/13 (0 it.fails).
- Strict refute harness (.bc/spine-s2-r6-prop5-strict.test.ts, not committed), seeds 2100001/2500001/2900001 x5000 at CENC 0: pulse-only 0 violations; mixed V4 2/3/3 (= base, pre-existing), V5 2/2/1 (base 4/5/1).
- Joins, pulse-only, seed 2100001 (base -> R6): CENC 3% 231 -> 155 (-33%); CENC 1% 68 -> 50 (-26%). Non-cenc violations: none new; cenc-tagged violations fell (V10 898 -> 614 at 3%).
- Gate (.bc/gate.log, 4 workers): typecheck + typecheck:tests 0; vitest `Tests 4 failed | 9532 passed | 5 skipped (9541)`: e11 sweep and no-identity-literals (base failures, none in spine) + 2 arch17-deferred-settle-pg (load timeouts; rerun alone `16 passed`). build 0 (own run, after the gate); check:silent 9 findings (accepted). Swift N/A on Linux.
## Mutants (.bc/spine-s2-r6-mutants*.log): refute M1-M19 + new N1-N11
Killed: all but M3/N2/M15 (equivalent now: the G1 clash subsumes the machine check; the pulse-pqm requirement is implied), M16 (near-equivalent, UNPROVEN, as the refute), M19 (killed by the strict prop run, not by unit tests). New mutants: G1 check dropped N1, held list dropped N3/N4, frozen inheritance allowed N5/N6/N7/N11, V5 attach/tie/multi-consult N8-N10 all killed (N2 equivalent: a pair with a null y machine is already refused by the proven-pair test).
## Assumptions / open risks
- V5 is a heuristic: the data cannot say whose pqm it is; a pqm tied between two pulse groups is left standalone (2/2/1 of 5000 mixed days remain, low). A pqm captured by another consult's pulse could still be pulled in when that group alone holds its span best.
- F1 holds a same-consult new pulse too when it shares no key with the home-bearer (safer reading; mark, never delete).
- S7 must read `held`; lib/spine has no other consumer yet.
