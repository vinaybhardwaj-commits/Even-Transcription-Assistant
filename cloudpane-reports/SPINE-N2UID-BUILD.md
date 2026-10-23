# SPINE-N2UID-BUILD — consult_uid / consult_key Pulse form = the real 26-char rule
Branch spine/n2uid-format (off origin/main 3380cf9c, includes #203). Builder: Sonnet on c3.

## Changed
- tools/eta-spine/phi-rules.json: consult_uid = `pqm_[0-9a-f]{22}` (unchanged) | `(?=.*[a-z])(?!.*[0-9]{10})[a-z0-9]{26}`; consult_key = `(?=[0-9]*[a-z])(?!.*[0-9]{10})[a-z0-9]{26}@(?!.*[0-9]{7})<machine part unchanged>`.
- lib/spine/phi-screen.ts: FORMAT DERIVATION text (probe fact, N1 note); UNGUARDED now uses replaceAll (consult_key now holds a 10-run and a 7-run guard; JS replace() removed only the first match, Python removes all).
- tools/eta-spine/post_signals.py: reads the same json, so only comments changed.
- lib/spine/enqueue-store.ts: tick gains `totals` (rows per status for the pass's encounters, read after insert; {} when no encounters). Per-pass fields unchanged.
- Fixtures/tests: tests/fixtures/spine-phi-cases.json (accept/refuse matrix for both keys, 16 new value_cases n2_*); 24/25-char synthetic `uidtest…` ids in 8 test files lengthened to 26; new N2 totals test in spine-p2-oref-r4-pg.test.ts.

## Minting-path check (STOP condition)
No code in the repo mints a Pulse uid. lib/buddy/relay.ts:82 SAFE_CONSULT_UID (20-32) is a consumer-side validator; consult_uid = Pulse encounter_id (compute.ts:253). The only evidence of length is fable's probe (1238/1238 = 26). Not stopped; UNVERIFIED beyond the probe (a non-26 Pulse id would now be refused at ingest).

## Tests (own .bc/gate.log)
- typecheck, typecheck:tests: clean. build: "Compiled successfully", 21/21 static pages.
- vitest: `Test Files  521 passed | 1 skipped (522)` / `Tests  10425 passed | 7 skipped (10432)`.
- check:silent: "Found 9 silent-failure handler(s)" = the 9 accepted pre-existing; exit 1 as at base, no file outside the contract touched.
- eta-spine pytest: `298 passed`. swift: N/A on Linux.
- Differential (/tmp/spine-n2uid-diff/diff.py: fixture + 100000 random strings, old vs new rules): rules json identical except formats.consult_uid/consult_key; verdict changes only on consult_uid (24966) and consult_key (44), every one a `[a-z0-9]{20,32}(@..)?` Pulse-form string; 0 changes on every other key; pqm hex form unchanged.

## Assumptions
- Machine part of consult_key keeps its 7-digit guard (reading "UNCHANGED" as behaviour); so a machine with a 7-9 digit run is still refused, `.digit_run`.
- consult_key's letter lookahead is `(?=[0-9]*[a-z])` (enc part only), not the pulse_enc_id text `(?=.*[a-z])`, which would see machine letters. Same behaviour on the enc part.
- N1: letter lookahead is implied by the 10-run guard; pinned: all-digit values get the plain reason, not `.digit_run` (n2_uid_all_digit…, n2_key_all_digit…, n2_pulse_enc_id_all_digit…).
- Migration number: none added.

## Open risks
- Lowercase UHID-like prefix + letters at exactly 26 chars with runs under 10 is accepted (same limit as pulse_enc_id: charset/length/letter/phone only).
- Mutants: none run (no reset/count mutant list given for this slice).
