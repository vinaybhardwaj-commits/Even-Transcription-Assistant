# main-green R3 build (tests only, no production code change)
Branch spine/main-green-fix on 054de95b. Fixes the three items of .bc/spine-main-green-r2-oref-REPORT.md.

## Changes
- tests/unit/spine-artefacts-r2-oref.test.ts (A8): `cost()` work now also adds "Rows Removed by Filter" and "Rows Removed by Join Filter" x the node's loops (EXPLAIN reports them per loop). A correlated Seq Scan with empty output reads and discards every row on every loop, so its discards are real work; the bound stays 400 x PAGE x reb/60k (800k at 1x; the real SQL measures ~612k, 1.3x margin, 2x data scales with the table).
- A8 also measures the real SQL with a non-empty blind set (2 entries, the default production shape) at 1x and 2x, with the same K and work bounds.
- tools/eta-consult-steward/tests/test_fixes.py: the given-name part of the fake label (`fake_label(n).split()[1]`, no literal) added to the index probe list and the alerts probe.

## Gate (.bc/gate.log, 4 workers, foreground)
- typecheck, typecheck:tests: OK. build: "Compiled successfully in 7.5s".
- vitest: "Test Files  507 passed | 1 skipped (508)", "Tests  10243 passed | 7 skipped (10250)", 0 failed.
- check:silent: "Found 9" = the accepted 9 (gate=1 from that alone). swift: N/A on Linux.
- Steward pytest (PYTHONPATH incl. /tmp/r2oref-pydeps for boto3): "78 passed".
- Real catalogPageSql A8: passed 3x (gate, targeted x2), "work":612503 / blind 612103, maxJoinFilterRemoved 0.

## Mutants (scratch /tmp/spine-main-green-r3-m; all reverted, git diff shows only the two test files)
- G7 (correlated count(*) over consult_index, seq scan, no-op semantics): KILLED, "expected 12616000 to be less than or equal to 800000".
- G3 (rbl join on LIKE): KILLED, blind-set run "expected 599900 to be less than or equal to 20000" (blind=[] still 0).
- G1 (reader reverted to unfenced): KILLED (101832780 > 20000). G2 (IS NOT DISTINCT FROM): KILLED (359998000). G4 (fence removed): KILLED (101832780).
- G5 (bounds loosened to 1e12): KILLED by the negative-control assert ("the guard failed to flag the old plan"). G6 (tighter work bound) not re-run: it was killed in R2 by the same bound line, unchanged here.
- S3 (flag leaks given name), S5 (doctor_name leaks given name), S6 (alert leaks given name): KILLED (S3 2 failed, S5 2 failed, S6 2 failed); steward otherwise 78/78. S1/S2/S4/S7 not re-run (probes unchanged).

## Assumptions
- Mutants are my reconstructions of the refuter's descriptions, not its exact files (not copied in).
- The work measure now includes scan discards, so the 1.3x margin is smaller than R2's 1.45x; bound left unchanged as ordered.
## Open risks
- Bound remains empirical (linear in table size).
