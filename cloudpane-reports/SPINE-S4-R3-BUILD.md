# SPINE-S4-R3-BUILD — spine/s4-recon on top of 156a2590 (host asus)
## Changed
- tools/eta-spine/spine_recon.py: G1 IST date only from ist_date or zone-aware ts/t_close/t_open; bare date/day and naive ts are UNDATED unless a {"tz": "Asia/Kolkata"|"UTC"} header (bare date only under Asia/Kolkata; unknown tz = bad line). G2 two_uids_encounters ids via enc_code(), else counted `redacted_id` (+ `redacted_ids`); docstring fixed. G3 code() strips [-. ()+] before the 8-digit check. G4 any unexpected exception in input handling = BROKEN INPUT exit 2; exit 1 only for gate=fail.
- Tests ported: tools/eta-spine/tests/test_spine_recon_r2.py (+ new G1-G4 tests), test_spine_recon_oref.py; tests/unit/spine-oref-r2/ (oref-s4 test + base-route.ts, the 3 byte-identity tests). test_spine_recon.py literals built at run time.
## Gate (own .bc/gate.log, 4 workers)
- typecheck, typecheck:tests: ok. build: exit 0 (.bc/build.log).
- pytest tools/eta-spine: 70 passed. oref-r2 vitest: 10/10.
- vitest full: Test Files 2 failed | 454 passed | 1 skipped (459); Tests 2 failed | 9388 passed | 5 skipped (9433). Plus 4 "Timeout calling onTaskUpdate" worker errors (load, 20 min run).
- The 2 failures are e11 SWEEP and no-identity-literals (19 offenders after my fix of one literal in my own test; 0 in spine files), both failing at base 60d3d823 per the R2 refute. Gate chain stopped there; build and check:silent were run separately.
- check:silent: exit 1, exactly the 9 accepted findings, none in spine files. swift: N/A on Linux.
## Mutants (builder suite alone, mut.py ported to /tmp/spine-s4-r3-mut)
- The refute's 42: 42/42 killed (T10 now killed by the byte-identity tests; N17/N18 killed via stderr-message asserts). New N21-N28 (bare date accepted, naive ts accepted, G2 bypass, dashed phone, catch-all off, date filter off, UTC header=IST, redacted count): 8/8 killed. Tree restored (only the intended files modified).
## Assumptions / risks
- Header may sit anywhere in the file; applies to the whole file. Bare date under tz=UTC is undated (cannot give an IST date).
- Real ledger shape still UNVERIFIED (file withheld); shadow gate on a real clinic day NOT RUN. Jev not run (not in tool list).
