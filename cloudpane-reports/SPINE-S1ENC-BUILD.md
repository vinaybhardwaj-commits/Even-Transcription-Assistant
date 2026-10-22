# SPINE-S1ENC-BUILD — real pulse_enc_id format (branch spine/s1enc-format, base 2528005d)
## Changed
- tools/eta-spine/phi-rules.json: formats.pulse_enc_id = `^(?=.*[a-z])(?!.*[0-9]{10})[a-z0-9]{26}$` (26 chars [a-z0-9], one letter, no run of 10+ digits: Indian mobile 10, +91 form 12). _comment updated.
- lib/spine/phi-screen.ts: FORMAT DERIVATION block now states the probe fact; new PHONE_GUARD; UNGUARDED strips both guards, so `.digit_run` still reports a guard-only refusal (all other keys unchanged: they contain only the 7-digit guard).
- tools/eta-spine/post_signals.py: same PHONE_GUARD strip in _UNGUARDED (reads the same json).
- tests/fixtures/spine-phi-cases.json: pulse_enc_id accept (7/8/9-digit runs, 26 letters, two 9-runs) and refuse (10-digit phone in 26 chars at several positions, all-digit 26, uppercase, 25/27 chars, `_` and `-`, ramesh_ name token, bare 7-digit, bare 10-digit, +91 phone, UHID-like shapes, old placeholder ids); signal cases use a 26-char id; `pending_probe` now empty; {DIG9} placeholder added.
- spine-phi.test.ts / test_phi_screen.py: {DIG9} fill; pending_probe special case removed.
## Rejection share (uniform random 26-char [a-z0-9], exact DP)
- new rule: 0.00343% (run of 10+ digits 0.003434%; no-letter 3.4e-15). Old 7-digit guard: 0.188% by my calculation (brief said 0.34%; I could not reproduce that figure under a uniform model, the new rule is far under 0.01% either way).
## Tests (own runs)
- `spine-phi.test.ts`: 17 passed. Python `tools/eta-spine/tests/test_phi_screen.py`: 18 passed (full eta-spine suite also run, see below).
- Full gate (.bc/gate.log): typecheck, typecheck:tests OK; vitest `Test Files 521 passed | 1 skipped (522)`, `Tests 10424 passed | 7 skipped`; build `Compiled successfully`; check:silent `Found 9 silent-failure handler(s)` = the 9 accepted pre-existing, so gate=1 comes from those only. 0 new failures. swift build/test N/A on Linux.
## Id-key differential
- Only the pulse_enc_id regex changed in phi-rules.json (git diff); all other formats byte-identical; their fixture cases untouched and green.
## Assumptions
- All-digit 26 string reports plain `attrs_ids.pulse_enc_id` (no letter), not `.digit_run`; 10+ run with letters reports `.digit_run`.
- A 26-char lowercase name-shaped token with no underscore (e.g. all letters) is indistinguishable from an id and is accepted by design; `ramesh_...` is refused (underscore).
- A UHID-like token of 26 chars with a letters+8-digit shape is accepted (no format can separate it); shorter/uppercase UHID shapes refused.
## Open risks
- Real-id format rests on the gating-lead probe; unverified here. Other tests that fed old placeholders (pulse_enc_test_01) passed in the full gate.
