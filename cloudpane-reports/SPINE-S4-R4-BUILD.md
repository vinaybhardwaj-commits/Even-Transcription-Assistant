# SPINE-S4-R4-BUILD (spine/s4-recon, on d039442f, host asus)
Changed (only tools/eta-spine; no lib/ or app/ file touched, no migration, no timer):
- spine_recon.py: H1 one tz header, first non-blank line only; a second, late or conflicting header is a bad line and is never applied. H2 a ts / t_close / t_open with no time part is undated. G3 SEPARATORS now strips `_` and `:` too (99999_44444 -> other). G4 write_atomic OSError -> exit 2.
- tests: test_spine_recon_r3.py (refuter's test_r3 ported, import path fixed) + builder tests for late/second header, date-only ts, enc_code (kills R14), underscore/colon phone, unwritable --out. Two old assertions updated to the new rules (test_header_anywhere in r2: late header now rc 1; test_F4 `uid_12345_6789` -> `uid_1234_567`, since 9 digits across `_` is now redacted by design).
Tests (own runs):
- pytest tools/eta-spine: "98 passed" (was 70; r3 file 27 incl. refuter's 23).
- Python mutants vs builder suite alone: 44/44 killed (all spine_recon mutants of the refuter's set incl. R1-R14, with R7/P8 re-anchored, + new: header-anywhere accepted, late header accepted, date-only ts accepted, underscore strip removed, OSError handler removed, first-flag off). TS mutants not rerun: no TS changed.
Gate (.bc/gate.log, `--maxWorkers=4 --minWorkers=1`; plain `--maxWorkers=4` errors in this vitest with "minThreads and maxThreads must not conflict"):
- typecheck, typecheck:tests: pass. vitest: "Test Files 2 failed | 455 passed | 1 skipped (459); Tests 2 failed | 9421 passed | 5 skipped (9433)". The 2 failures are e11-silent-room-window SWEEP and no-identity-literals, both failing identically at base 60d3d823 per the R3 refute; no spine file involved. 2 onTaskUpdate worker timeouts (load), no extra test failed.
- The && chain stopped at vitest, so I ran the rest separately: npm run build exit 0; check:silent exit 1 with the accepted pre-existing findings (none in spine files; count not re-verified line by line). swift: N/A on Linux.
Assumptions: header is only a line with `tz` and no consult_uid; a bad `tz` value on the first line still consumes the "first" slot. A date-only test is "no `T`/space followed by 2 digits".
Open risks: UNVERIFIED real ledger shape/zone; shadow day not run. Dashed dates in stage names become "other" (fail-safe).
