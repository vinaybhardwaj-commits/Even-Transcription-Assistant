VERDICT: FAIL

FRX-R2 refute. Handle cloud-frx-r2-refute. Target `cloudpane/cloud-frx-r2-build/r2`, code `9c5d3dea` (fd65cdc6 is report only), base R1b `ea2818ee`, original base `3cdb7c0b`. Synthetic data only. Model serving this refute: claude-opus-5-5. Harness: `cloudpane-reports/frx-r2-refute-harness/` (my own; it reuses only the fixture builders `mk_consult`, `empty_encounter` and the brief-named `gen_consult`).

The verdict's own defects are fixed on the verdict's own setups. The rules behind them do not hold beyond those setups: three floor breaches (F1, F3, F6) and a red-flag loss (F4). The gate is green.

Gate (run by me: Python 3.11.17 fresh venv, requirements.txt, git worktree at 9c5d3dea):
- FULL suite `pytest -c tools/eta2freescript/pytest.ini tools/eta2freescript/tests -n 3`: `4009 passed, 2 skipped` in 1154.83s, exit 0. (From a git-archive copy without history: 1 error and 15 skips, all from `git rev-parse`, so the worktree run is the valid one.)
- `build_v02 --check` / `build_v03 --check`: `v0.2 schema up to date` / `v0.3 schema up to date`, exit 0.
- Vendored `validate_artifact.py` on the 3 w38 examples: OK ex1, ex2, ex3, exit 0.
- py_compile, Python 3.10.20, on the 4 changed .py files: 4/4 OK. gitleaks 8.30.1 `detect --no-git` on the 6 changed files: `no leaks found`.
- tests/ diff against R1b: `test_r2_fixes.py` is new. `test_r1_floors.py` has 2 expectation flips (amoxil prefix), which is ruling L2 itself and an R1 file. No base test file was touched by R2.

Prior defects, re-run with my harness:
- D1 (OFF byte-identical), seeds 1000-1499, base 3cdb7c0b against R2 `notes_only=False`, nothing filtered. Identical in 500/500 on each check: note_text, artifact, model calls, written, final_errors, whole log minus timings, and the artifact/v0.1/rejected files. PASS.
- D3, my own 600 runs: paracetamol said by an unknown speaker as the generic, Calpol, Dolo 650, Crocin, PCM or Dolo. The LLM note names it in one of 14 spellings across 7 sections, and posted advice names it in 40% of runs. Written 600/600. R1 moved the drug in 558 runs, and it is visible in 0 of them; posted gp_extraction is also clean. PASS on this setup, but see F1 and F2.
- D5: the verdict's 7 cases post 0/7 (R1b 7/7). My 20 qualifier cases post 1/20 (R1b 12/20). The one is `Pan 40` on "Pan masala stop.", see F6. Legitimate base word on tape: 15/16 post, see L1.
- L1: 10 negated or non-clinical sentences fire 0/10 (R1b 9/10). My 16 routine sentences fire 0/16 (R1b 0/16). True red flags fire 11/14 (R1b 12/14), see L3.
- L2: the 16 dangerous pairs false-accept 0/16 (R1b 16/16). My 20 Indian OPD look-alike pairs, both directions, false-accept 0/40 (R1b 0/40). But see F3.
- M2 / M5 (the prior verdict's mutants) on R2: MUTANT_M2M5_LINE.

Safety floors on R2 ON, gen_consult seeds 1000-1499, 384 written: 0 posted medicines without a doctor name quote, 0 dose digits off tape, 0 check() errors (FRX-M4 dose precedence included), 0 posted_hits, 0 printable_errors, 0 bracket/placeholder in note_text. Clip: a doctor red-flag turn that the boundary quarantined is not carried (0).

Findings:
1. F1 FAIL (D3 does not generalise; floor: 0 drugs without tape support). r1_floors.py:437-456 `guard_names` knows only name, raw_name, aliases, owner names, the 12-entry `medication_safety.BRANDS`, and the paracetamol-only `GUARD_ALIASES`. Stage A's `generic` and `brand_as_said` are not carried.
   - Repro: `h3.py` GEN-D3. 300 runs over 15 Indian OPD generic/brand pairs (Azee, Pan 40, Pantocid, Cetzine, Mox, Brufen, Montair, Glycomet, Amlong, Domstal, Emeset, Levocet, Taxim-O, plus Dolo 650 and Calpol). The drug is said by an unknown speaker, and the LLM note says "continue <generic or brand> as advised".
   - Result: R1 moved the drug in 232 runs, and it is visible in **83/232 written notes** (35.8%):
     - said generic, note names the brand: 64;
     - said brand, note names Stage A's own generic (e.g. Azee/"azithromycin"): 11;
     - said brand, note names that same brand: 8 (Mox and Pan 40 drop out of the medicine dict, whose names are `[]`).
   - The 600/600 PASS above holds only because `GUARD_ALIASES` hard-codes paracetamol (my X1 mutant confirms it).
   - Fix: carry the rx row's generic, brand_as_said and `_heard_name` into the moved drug's guard names, and resolve molecules through the drug lexicon (`data/drug-lexicon.json`), not a hand table.
2. F2 FAIL-contributing (R1-4 "pick_drug drugs never appear in note_text"). In the same 600 runs, the 42 runs where the MAPPER made the pick_drug show the drug in **42/42 written notes**. These are Stage A generic null (23) and an unresolved `PCM` (19). Example: seed 25, "Plan of Management: continue PARACETAMOL as advised".
   - The same happens for mapper-held Okacet/cetirizine, calcium, vitamin D3 and potassium chloride (`h2_d3.py` D3-qual).
   - `moved_in_note` (pipeline.py:186) checks only R1-moved drugs. R1 had the same scope, so this is not an R2 regression, but the contract line is unmet.
3. F3 FAIL (L2 false acceptance by split spelling; ruling 6: false acceptance is not acceptable). `name_in_text` matches a whole token, so an ASR-split prefix leaves the look-alike's tail as a token. 6/6 of my split cases post:
   - chloroquine on "hydroxy chloroquine 200 mg" (one of the 16 dangerous pairs);
   - prednisolone on "methyl prednisolone";
   - cetirizine on "levo cetirizine";
   - omeprazole on "es omeprazole";
   - ofloxacin on "levo ofloxacin";
   - amoxicillin on "amoxicillin clavulanate".
   - Repro: `h4.py` "L2 split-spelling".
   - Fix: refuse the match when the preceding token joined to the name is another drug, or is a prefix (hydroxy, methyl, levo, es, dex, des).
4. F4 HIGH (over-withholding; red flag lost; ordering bug). r1_floors.py:697-701: R1-5 decides "covered" BEFORE R1-2b withholds the whole `general_advice` string.
   - Repro (`h3b.py` MULTI): ibuprofen said by an unknown speaker (moved). The doctor's advice is "Avoid ibuprofen because of the ulcer; Drink warm water; If you vomit blood, go to the emergency immediately".
   - R2 result: `general_advice` is None, and the note has an empty "General Advice:". It is written, with `r1_5_covered=1` and `r1_2b_withheld=1`. Base keeps all three lines.
   - Single-advice safety cases (`h3.py` SAFE-ADV) are withheld 3/3: "Avoid ibuprofen because of the stomach ulcer.", "Stop metformin two days before the CT scan.", "Do not stop aspirin before the procedure."
   - Fix: run R1-2b before R1-5. A negated or stop/avoid mention is not a drug-use mention. Fable to rule on withholding one "; " advice item instead of the whole field.
5. F5 HIGH (R1b flag "R1-5 G1 pointer clash", still open; posted-drug recall). ON rejects **116/500** (23.2%), every one with `G1 advr1_N: json_pointer /general_advice already claimed by advN`. R1b gives the identical 116.
   - Doctor-confirmed drugs written: base 413/413, R2 **313/413**. Inside the artifact R2 posts 413/413, so the whole loss is this rejection.
   - R2 against R1b on these 500 consults: medicines, note_text and written differ in 0, so R2 breaks nothing that R1b's B1-B4/F2 set up. Nothing unsafe is written, but the default mode drops a quarter of notes.
   - Fix (R1c): the R1-5 item cites the existing advice owner, or its json_pointer is null.
6. F6 MED (D5 floor: drug without tape support). `name_phrases("Pan 40")` is `(pan,)`, so `Pan 40` posts on the doctor quote "Pan masala stop." A short brand that is an everyday word needs its strength or a form word next to it on tape.
7. F7 MED (D3 qualifier-only names). `guard_names` drops a name with no phrase. An R1-moved "Calcium", "Zinc" or "Iron" (patient evidence, `apply_r1_ex` on `hand_art`) leaves the posted advice "take calcium daily" untouched, for 3/3.

LOW:
- L1. `Calcium + Vitamin D3` never posts, even said verbatim ("Calcium with vitamin D3 daily"). A lone-qualifier component makes `name_phrases` return []. This is the builder's F5 over-move; it is common in Indian OPD prescriptions.
- L2. A misspelt moved drug ("paracetemol", "para-cetamol", "P-650") stays visible. This is outside ruling 4's wording.
- L3. Red-flag misses: "If he becomes drowsy, bring him to casualty immediately" (R1b misses it too), "If the pain is not better in two days, come back", and "If the fever continues, come back" (ruling 7 dropped `continues`).

Mutants of my own on R2's changes (`mutants.py`, run against test_r2_fixes.py + test_r1_floors.py, -x):
- Killed 5/12:
  - X1 GUARD_ALIASES emptied: `test_d3_moved_drug_never_visible_in_600_runs`.
  - X4 lone qualifier counts: `test_d5_qualifier_word_alone_goes_to_pick_drug[Calcium-…]`.
  - X6 question check off: `test_l1_negated_and_non_clinical_never_fire`.
  - X9 stored-note fallback off: `test_d3_stored_note_that_names_a_moved_drug_is_replaced`.
  - X11 "d3" dropped from QUALIFIERS: `test_d5_qualifier_set_covers_the_ruling_words`.
- SURVIVED 7/12 (412 passed under each). This is F8 below.
  - X2 guard ignores owner names (r1_floors.py:441).
  - X3 R1-2b single pass (:467).
  - X5 `_NOT_A_NAME` filter off (:454).
  - X7 red-flag cue not required (:572).
  - X8 NEGATION "need not" dropped (:552).
  - X10 pipeline keeps a note naming a moved drug, the reject removed (pipeline.py:195).
  - X12 guard skips molecule brands (`BRANDS`).
- F8 MED (test strength). Two survivors are safety paths:
  - X10, the last-line reject of a note that still names a moved drug, is never exercised;
  - X12 shows the BRANDS link is untested.

Required to pass: F1, F2, F3, F6 and F7 to 0, F4 fixed, F5 fixed or ruled. Re-run `h3.py` and `h4.py` as the oracle.
