# SPINE-S2-R4-BUILD (spine-s2-r4, branch spine/s2-merge on a813683b)
Verdict: PASS (pure merge only; shadow, no flag, nothing outside lib/spine imports it).

## Changed
- lib/spine/merge.ts, lib/spine/types.ts (KeyKind + `pulse_enc_id`, flag `covered_by_pulse`).
- M2: `pulse_enc_id` read from attrs.ids.pulse_enc_id, opaque string, a match key and a link kind. A shared value overrides the same-kind strong conflict (two machines = ONE encounter, `multi_machine` when the strong signals carry distinct consult_key). consult_uid keeps the same-machine rule. Header cites the ruling.
- M6: header cites "no stretch"; idle_timeout cap at the next strong open is tested explicitly.
- X2 variant D (reviewed line by line, ported with a null-kind guard): no time-only pulse+pqm merge when both groups own a live prior of their own kind. `covered_by_pulse` on a pqm-anchored encounter >= 90% inside an explicitly closed pulse encounter in the same room (no merge).
- R3-B: a group holding a strong signal whose identity link (else stale id) names a frozen encounter of its room mints nothing and is not emitted; every strong signal stays on its frozen home.
- R3-C: the frozen-loser keep rule is weak-only. R3-D: strongOwner never falls back to a stale id when an identity link exists, and room-checks the stale id.
- V6 (found by prop3 seeds 504457/900001, also on base): a weak leftover group's copy of an identity key could win the link over the strong owner. Links supplied by a strong signal now rank first (after "keep").
- Tests: spine-merge-prop3.test.ts (refuter, unchanged), spine-merge-fix3.test.ts (unchanged), spine-merge-r4.test.ts (16 new: M2, M6, D, covered_by_pulse, M13, N3b, N6, M16).

## Tests (own runs)
- prop3 seeds 500001/700001/900001 x 5,000, pulse-only AND mixed: 0 violations each (95/95, 95/95, 95/95 in spine-merge*; now 107/107 with r4).
- `vitest run tests/unit/spine-merge`: Tests 107 passed (107).
- Gate (.bc/gate.log, gate2.log, gate3.log): typecheck and typecheck:tests exit 0. vitest in 2 sequential shards, 4 workers (`--minWorkers=1 --maxWorkers=4`; plain `--maxWorkers=4` errors "minThreads and maxThreads must not conflict"): shard 1 "1 failed | 4541 passed (4542)", shard 2 "1 failed | 4898 passed | 5 skipped (4904)". The 2 failures are e11-silent-room-window sweep and no-identity-literals (19 items, none in spine): same as the R3 refute's base run, so new failures vs base: 0. build exit 0. check:silent exit 1, the same 9 accepted findings. Swift N/A on Linux. No migration touched.

## Mutants (.bc/spine-s2-r4-mutants.log; script /tmp/spine-s2-r4-mut/run.py, merge.ts sha256 verified restored)
26 run. Killed: M1,M3-M12,M14,M15 and N1,N2,N3,N4,N7-N11. First pass survivors M13, N3b, N6 (and M16 killed only by prop3): fixtures added to r4 tests, re-run: M13, N3b, N6, M16 all killed. Survivor: M2 (assert before losers) = documented equivalent. N4 = keep rule on pulses with the home rule off.

## Assumptions
- "Nothing is minted for a past-horizon day" is implemented only for groups with a strong signal homed on a frozen encounter. A brand-new weak group on a frozen day still mints (a test mints 2,000 windows at now far in the future).
- X2 was not ruled: variant D is the interim safer reading, as ordered.

## Open risks
- UNVERIFIED: pulse_enc_id format and placement (attrs.ids.pulse_enc_id) have no real rows here.
- If two pulse priors already exist for one pulse_enc_id (created before the id was seen), the older survives and the other stays a live, unemitted row (M4 forbids same-kind loss). The writer should handle or flag it.
- covered_by_pulse and dual-consult duplicates remain (R3 refute: ~63% of unkeyed dual consults give two confirmed encounters); S7's writer must honour the flag.
