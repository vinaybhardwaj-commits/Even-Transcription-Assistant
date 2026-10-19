# SPINE-S2-R2-BUILD (round 2: fixes from the Opus refute; still pure merge, no writer)
Branch spine/s2-merge on top of 242803dd.
## Changed
- lib/spine/merge.ts: F1 anchor-claim rule + exported assertUniqueIds (throws on a duplicate id); I2 any positive overlap flags pulse_overlap (raw spans); I3 clamp + flag `clamped`; I4 frozen-link guard; A2 consult_uid needs a matching machine. Header comment documents each reading and its plan line.
- tests/unit/spine-merge-oref.test.ts (refute's file, 19 tests, moved from .bc/), tests/unit/spine-merge-r2.test.ts (10 new tests).
## Tests (own runs)
- `npx vitest run tests/unit/spine-merge`: Tests 64 passed (64) before the assert export; 65 after (Test Files 3 passed).
- Full gate .bc/gate.log (4 workers, minWorkers=1, foreground): typecheck ok, typecheck:tests ok, `Test Files 2 failed | 451 passed | 1 skipped (454)`, `Tests 2 failed | 9393 passed | 5 skipped (9400)`. The 2 failures (e11-silent-room-window, no-identity-literals) are the same two that fail at base e9f7e6a2 (per the R1 report and the refute): new failures vs base = 0.
- `npm run build` exit 0. `npm run check:silent` exit 1 on pre-existing findings, 0 in lib/spine. Swift N/A on Linux.
## Mutants: 14 run, all killed (failing tests in parens)
Builder 8: drop M4 (9), 50->40 (3), 120s->60s (1), rank swap (1), M7 tie later (1), survivor newer (1), 72h->48h (1), drop 8-digit check (1). Refute: M16 doctor_activity rank (1), M19 weak_agree without meets (1). New: drop anchor-claim (1), drop uniqueness assert (1), drop clamp (1), drop frozen-link guard (1).
## Assumptions
- F1: a strong prior is claimed by the group holding a member of its anchor kind whose stale encounter_id or identity key (consult_key | pqm_uid) resolves to it. A pulse-anchored and a pqm-anchored prior MAY still merge (different kinds, plan M8 late join); only same-kind strong priors are never survivor/loser.
- The uniqueness assert is unreachable once the claim rule holds, so it is a tested backstop (assertUniqueIds unit test), not a fixture.
- I3 (pending fable): clamp applies to a weak or inferred close/open, including a pulse idle_timeout close, against any neighbour with a pulse or pqm member. If clamping would leave an empty span the raw span is kept. pulse_overlap is computed on the raw (unclamped) spans so both consults stay flagged.
- I4: a link whose prior owner is frozen stays with it; options moving to a frozen encounter from another owner are dropped. New links on a frozen encounter (no prior owner) are allowed.
- A2 as in the merge.ts header (pending fable).
## Open risks
- Greedy grouping remains order-sensitive for weak groups (unchanged). Clamp rule untested against a pqm neighbour. Migration number 0173 still taken on two branches (R1 note); not needed this round.
