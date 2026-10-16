VERDICT: FAIL

FRX-R1 refute. Handle cloud-frx-r1-refute. Target `cloudpane/cloud-frx-r1-build/r1`, code `2e4a51e5` (89a757ca is OUTBOX only), base `3cdb7c0b`. Synthetic data only.

Contract scope: PASS. All 9 code files are on the allowed list, and no existing test file was edited.
Floors: R1-1 PASS (r1_floors.py:43-271, validate.py:415-419). R1-2 PASS to the letter (r1_floors.py:285-323), see D5. R1-3 PASS (r1_floors.py:335-354). R1-4 FAIL (D1, D2, D3). R1-5 PASS, see L1.

Gate (run by me: Python 3.11.17 venv, requirements.txt, pytest, xdist):
- build_v02 and build_v03 `--check`: up to date, exit 0. Vendored validator on the 3 w38 examples: OK, exit 0.
- FULL suite: `1 failed, 3895 passed, 2 skipped`. The failure is `test_sanitize_span_reject.py::test_m4_repaired_llm_note_that_loses_a_span_is_not_kept` (`note_repaired` True, expected False). It matches the builder's B1. The gate is RED.
- py_compile under 3.10.20: 7 of 7 OK. gitleaks 8.30.1 on the 9 changed files: no leaks, exit 0.

Defects:
1. D1 (R1-4, OFF is not byte-identical): pipeline.py:198 and validate.py:415. FRX-G1 runs in `frx()` whatever the mode, so with `notes_only=False` it enters `final_errors` and blocks the write. On 500 FakeClient consults (gen_consult seeds 1000-1499) against base `run_consult`: note text identical 500/500, artifact identical 500/500, model calls identical 500/500. But `written` differs in 88/500 and `final_errors` differs in 88/500. First case: seed 1004, `FRX-G1 /examination ... (bracket)`. Expected: OFF behaves exactly as base. Got: 17.6% of consults are rejected. The builder's own oracle test filters FRX-G1 out of its comparison and so hides this.
2. D2 (R1-4, the label is never present): r1_floors.py:469-484, note.py:413. The contract requires the first Medication line to be exactly the label, and the label to pass printable_errors. `printable_errors("Medication: <label>")` returns `d1 'unconfirmed'` and `d2 'confirms'`. Vendored G6 also rejects any extra Medication line. `notes_only_note` therefore always drops the label: `r1_4_label_kept` is 0 in every run. The contract is unsatisfiable as written (the builder's B2/B3). The lead must rule on the wording and on a G6/C4 exemption.
3. D3 (R1-4, a moved drug stays visible in note_text): pipeline.py:186-193 and r1_floors.py:487-497. Setup: an unknown-speaker paracetamol (R1-2 moves it), and an LLM note that names it under General Advice. Across 600 runs the moved drug is visible in the final, written note in 152 (25%):
   - Brand or short names: 136/136. Calpol, Dolo 650 and PCM under Advice never trip `pick_drug_in_note`, because `V.same_drug` gets only the pick_drug detail (the generic name) and the drug's aliases are not checked.
   - Generic name: 16 of the 64 Advice runs that used it. When posted general_advice also names the drug, the deterministic fallback fails the guard too, and the code KEEPS the LLM note ("continue paracetamol as advised"), only counting `r1_4_pick_drug_in_note=1`.
   - Plan-section mentions: 0 visible out of 203.
   Expected: never in note_text. Fix: match aliases and raw_name too. When neither note clears the guard, withhold the field that names the drug, or reject the note, but never keep it.
4. D4 (gate): the existing test above fails on the mandated default. The contract says "existing tests unchanged", so a red existing test is a gate failure. The lead must rule (builder B1).
5. D5 (R1-2, generic name words): r1_floors.py:285-288. `drug_words` accepts any 3+ letter word of the name, so salt and qualifier words count as the name on tape. In 7/7 cases the drug posted when the doctor quote shares only that word: folic acid / "acid reflux", pantoprazole sodium / "low sodium", vitamin D3 / "vitamin levels", potassium chloride / "potassium is low", calcium carbonate / "calcium in milk", Augmentin 625 Duo / "Duo pack". Expected: pick_drug. Fix: add salt, vitamin and pack words to `_NAME_STOP`, or require the base molecule word.

LOW notes:
- L1 R1-5 false positives:
  - 10/10 negated or non-clinical sentences fire: "No need to go to the emergency.", "You don't need to come back immediately.", "Go to ER? No, not needed.", "If you start feeling better, return to work/school/gym", "...return to normal diet". The `_WORSE` alternatives `start \w+ing` and `continues`, and bare `return`, are too loose.
  - On a hand set of 16 routine sentences, 9 fire. Of 2,000 generated conditional "come back next week" style sentences, 1,140 fire. Most of those are routine return instructions; the contract's "return instructions" arguably covers them.
  - Patient turns: 0 added. Non-English: skipped and counted. A clause over 200 characters is trimmed to 192. Phone and Dr-name are scrubbed from the line, which then passes printable_errors.
  - The raw clause, phone included, stays in the new item's evidence quote and decision quote. This matches the base mapper, which does not scrub evidence quotes.
  - Coverage edge: overlap 0.5 adds, 0.75 is covered.
- L2 The R1-2 prefix rule (as specified) false-accepts 16 of 2,862 ordered drug pairs (0.56%). Every pair is a clinically dangerous swap: prednisolone/prednisone; hydroxychloroquine, hydroxyzine and hydrochlorothiazide with each other; chloroquine, chlorpheniramine and chlorthalidone with each other; amoxicillin/amoxiclav. This is the contract's rule, so I raise it for the lead.
- L3 R1-3 (guard.numerals) treats "twice", "BD" and "one in the morning, one at night" as no digit. "2 times a day" and "1-0-1" are then off tape and the drug moves. This is fail-safe (over-moves).
- L4 R1-1 does not fire on `«x»` or `‹dose›` (Pi/Pf, which the contract does not require). It fires on lowercase "tbd". Split placeholders do not fire per half, which is correct.
- L5 R1-2: an owner whose speaker is `patient` but whose evidence speaker is `doctor` (speaker_source model_inferred) still posts. This follows the contract, which reads only the evidence speaker.
- L6 The builder's suite does not kill my mutants M2 or M5 (298 passed under each).

Adversarial results that held:
- R1-1, 2,000 seeded artifacts with 1-4 injections each (nested lists of dicts, fullwidth and lookalike brackets, double-quote reprs, legitimate parens, missing-value words inside longer words):
  - 0 hits survive;
  - 0 surviving strings differ from an input string (no character is ever stripped);
  - FRX-G1 fires on 0 outputs;
  - 0 new check() errors;
  - 0 legitimate strings withheld.
- R1-2, 3,000 scenarios (patient-only, unknown, alias-only, name only in another drug's quote, speaker disagreement, random removals): the floor holds in every case. Pointers are consistent, with 0 dangling. 600 more runs show 0 new FRX-PR*/M* errors.

Mutants of my own (all 8 killed by /tmp kill.py, all applied to r1_floors.py unless noted):
- M1 drop the Ps/Pe test;
- M2 4-letter prefix;
- M3 check the owner speaker, not the evidence speaker;
- M4 drop strength from the R1-3 fields;
- M5 coverage threshold 0.5;
- M6 trim at 400;
- M7 remove the pick_drug guard (pipeline.py:187);
- M8 drop "to be determined".
