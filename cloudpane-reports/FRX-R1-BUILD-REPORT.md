# FRX-R1 build report: FreeScript R1, notes-only restart floors

Handle: cloud-frx-r1-build. Branch: `cloudpane/cloud-frx-r1-build/r1`. Base: `3cdb7c0b`.
Model serving this build: `claude-opus-5-5` (`get_session`: `session_context.model` and `last_served_model` are both `claude-opus-5-5`). The brief named claude-sonnet-5.5. The commit trailer names the model that actually wrote the code (see flag F12).

**Verdict: built, with one gate line RED.** One existing test, `test_sanitize_span_reject.py::test_m4_repaired_llm_note_that_loses_a_span_is_not_kept`, fails because R1 changes its expected value. As the brief orders, I stopped on it and did not edit it (see section 5, B1). Everything else is green.

## 1. SHA

- Code commit: `2e4a51e5` (full: 2e4a51e5c480dc1f1e0a4b8745b7d2337c910ec0) (one commit: r1_floors.py, pipeline, note, validate FRX-G1, schema, nightly env, tests).
- This report: the second commit on the same branch.

## 2. Gate lines

| Gate | Result |
|---|---|
| fresh venv, `python3.11 -m venv`, `pip install -r tools/eta2freescript/requirements.txt pytest` | Python 3.11.17, installed |
| `python -m tools.eta2freescript.schema.build_v02 --check` | `v0.2 schema up to date` (exit 0) |
| `python -m tools.eta2freescript.schema.build_v03 --check` | `v0.3 schema up to date` (exit 0) |
| vendored validator, `validate_artifact.py tools/eta2freescript/vendor/freescript-w38/examples/*.json` (the path the workflow uses; `tools/eta2freescript/examples/` does not exist) | `OK ex1-fever-patient-own-drug.json`, `OK ex2-negation-no-antibiotic-no-xray.json`, `OK ex3-stopped-glimepiride.json` (exit 0) |
| FULL suite `python -m pytest -c tools/eta2freescript/pytest.ini tools/eta2freescript/tests -q` | `1 failed, 3895 passed, 2 skipped in 1674.44s` (exit 1). The 1 failure is `test_sanitize_span_reject.py::test_m4_repaired_llm_note_that_loses_a_span_is_not_kept`, flag B1. Every other existing test passes unchanged; 3895 = 3596 base − 1 + 300 new. |
| base 3cdb7c0b, same suite (`-n 4`, for comparison) | `3596 passed, 2 skipped` |
| `python3.10 -m py_compile` (3.10.20 via `uv python install 3.10`) on r1_floors.py, pipeline.py, note.py, validate.py, nightly.py, schema/build_v02.py, tests/test_r1_floors.py | all 7 OK |
| gitleaks v8.30.1, `gitleaks detect --no-git --source <copy of the 9 changed files>` | `no leaks found`, exit 0 |
| `GITLEAKS=… scripts/steward/scrub.sh --tree <copy of the 9 changed files>` | exit 0, 0 hits |
| (info) `scrub.sh --tree tools/eta2freescript` (the whole package) | 40 hits, every one in a file this build does not touch (pre-existing `env-secret-assign` in eval/pdqi9 floors oracles, `phi-field` in vendored examples, mutants and stageA fixtures). None in a changed file. |

New-test evidence (all in `tests/test_r1_floors.py`, 300 tests):
- R1-4 OFF oracle against 3cdb7c0b's `run_consult` (git archive, imported as a second package) with FakeClient: `200 consults, note and artifact byte-identical; 49 written->rejected by FRX-G1 only`. Model calls (alias, tag, prompt, system) are identical in all 200.
- R1-4 recorder, ON against base: `200 consults; Stage A identical in all; Stage B input identical 80, changed by R1 120; drugs moved 96`. The test asserts that Stage B's prompt is identical exactly when R1 left gp_extraction unchanged, and that every posted medicine passes the doctor-name floor.
- R1-1 property test: 2,000 seeded artifacts, 1-4 placeholders each, nested lists included. After `apply_r1`: zero posted strings match the set (on `posted_hits` and on an independent test-local regex), and FRX-G1 is silent on every 50th.

Mutants (each run on a throwaway copy; the first failing test is quoted):

| Mutant | Killed by |
|---|---|
| R1-1 skips nested lists | `test_r1_1_every_pattern_in_every_section_is_withheld[medicines/0/aliases/0-angle]`: `assert {'examination...} == {'examination...}` |
| R1-1 deletes characters instead of withholding | `…[examination-angle]`: `assert {'examination...} == {'general_adv...}` |
| R1-2 accepts any speaker | `test_r1_2_patient_only_evidence_goes_to_pick_drug`: `assert (['paracetamol...razole 40 mg'] == ['amoxicillin...razole 40 mg']` |
| R1-2 forgets the renumbering | `…[medicines/1/name-angle]`: gp_extraction mismatch (`test_r1_2_three_medicines_middle_removed_renumbers` covers it too) |
| R1-3 strips the digit only | `test_r1_3_digit_not_on_tape_removes_field_and_moves_drug`: `assert (['paracetamol...razole 40 mg'] == ['amoxicillin...razole 40 mg']` |
| R1-4 keeps the LLM Medication section | `test_r1_4_medication_floor_replaces_model_lines`: `assert (['cetirizine ...tamol 650 mg'] == ['Unconfirmed...re breakfast']` |
| R1-5 accepts patient turns | `test_r1_5_patient_sentence_adds_nothing`: `assert ('general_advice' not in {… 'general_advice': 'If the pain becomes severe …'})` |
| FRX-G1 removed | `test_frx_g1_fires_when_r1_is_skipped`: `assert [] == ['FRX-G1 /exa...et (bracket)']` |

## 3. Files changed

- `tools/eta2freescript/r1_floors.py` (new): `apply_r1`, R1-1 to R1-5, `notes_only_note`, `pick_drug_in_note`.
- `tools/eta2freescript/pipeline.py`: `Options.notes_only = True`; `apply_r1` right after `build`, before `flags` / `banned` / the fallback / Stage B; the deterministic Medication floor; the pick_drug-in-note guard; `log["r1"]`.
- `tools/eta2freescript/note.py`: `MEDICATION_LABEL` and `medication_floor` only.
- `tools/eta2freescript/validate.py`: FRX-G1 only (6 lines in `frx()`).
- `tools/eta2freescript/schema/build_v02.py`: `field_withheld` added to NEW_FLAGS.
- `tools/eta2freescript/schema/eta-freescript-artifact.v0.2.schema.json` and `.v0.3.schema.json`: regenerated by the builders.
- `tools/eta2freescript/nightly.py`: `notes_only_enabled(env)`, read at both `run_consult` call sites and checked once in `load_config`.
- `tools/eta2freescript/tests/test_r1_floors.py` (new).
- Outside the code commit: `cloudpane/cloud-frx-r1-build/OUTBOX.md` (the cloudpane rule) and this report.

## 4. Schema change (verbatim)

```diff
--- a/tools/eta2freescript/schema/build_v02.py
-NEW_FLAGS = ["boundary_quarantined", "doctor_dose_precedence"]
+NEW_FLAGS = ["boundary_quarantined", "doctor_dose_precedence", "field_withheld"]
--- a/tools/eta2freescript/schema/eta-freescript-artifact.v0.2.schema.json
@@ -760,7 +760,8 @@
               "boundary_quarantined",
-              "doctor_dose_precedence"
+              "doctor_dose_precedence",
+              "field_withheld"
             ]
--- a/tools/eta2freescript/schema/eta-freescript-artifact.v0.3.schema.json
@@ -1182,6 +1182,7 @@
               "doctor_dose_precedence",
+              "field_withheld",
               "translation_conflict",
```

`field_withheld` is not a v0.1 flag, so `to_v01` drops it from the v0.1 projection, as it already does for the other v0.2 flags.

## 5. Flags

### Blockers and contradictions in the brief (the lead must rule)

- **B1, an existing test blocked me (not edited).** `test_sanitize_span_reject.py::test_m4_repaired_llm_note_that_loses_a_span_is_not_kept` expects `note_repaired is False`. With R1 on (the mandated default), R1-1 withholds the investigation instruction `today [fasting]` (a bracket) at the source. The repaired note then loses no span, repair succeeds, `note_repaired` is True, the note posts from the LLM, and FRX-L1 does not fire. The defect the test guards against (`CBC (today)` posting after a span loss) cannot happen, because the field is gone whole. Checked with counts and booleans only: instruction absent, no bracket in the note, no `today` on the Further Investigation line, `final_valid` True. With `notes_only` defaulted off on a scratch copy, the whole file passes (270 passed). The test needs either `Options(notes_only=False)` or a new expected value; that is the lead's call.
- **B2, the label fails printable_errors.** The brief says `Unconfirmed list, not a prescription; the treating doctor confirms each drug.` passes printable_errors. Under Medication it does not: `FRX-N1 d1 missing-value phrase 'unconfirmed'` and `FRX-N1 d2 request word 'confirms'`. `test_r1_4_label_text_as_specified_fails_frx_n1` pins this.
- **B3, any label line fails vendored G6.** The vendored w38 G6 wants exactly one Medication line per gp_extraction medicine, so an extra label line fails G6 whatever its wording. I am not allowed to change the vendored validator or to touch validate.py beyond FRX-G1.
- **What I built for B2 and B3: fail closed.** `MEDICATION_LABEL` is the exact text. `notes_only_note` inserts it only if the artifact raises no new error with it. Today it never does, so `r1_4_label_kept` is 0 and the Medication section is the deterministic drug list with no label. If the label were forced in, every notes-only consult with a posted drug would be rejected. To ship the label the lead needs (a) wording that passes FRX-N1, for example `Draft list, not a prescription; the treating doctor checks each drug.` (checked: printable_errors returns `[]`), and (b) a validate.py change so that G6 / C4 / FRX-C2 skip the exact label line. A consequence for the v0.1 consumer: if the label line reaches `artifact.v0.1.json`, a reader that counts one line per drug will count it. I did neither (a) nor (b).
- **B4, FRX-G1 and the OFF switch.** FRX-G1 sits in `frx()`, so it also runs with notes_only OFF, where R1 has not cleaned gp_extraction. To keep the OFF note byte-identical, `run_consult` OFF ignores FRX-G1 errors when it chooses the note (`note_errs`). It still counts them in `final_errors`, so an OFF artifact with a placeholder in a posted field is not written: 49 of the 200 generated consults went from written to rejected. Note, artifact content and model calls stay byte-identical. If OFF must also keep the base write decision, FRX-G1 has to be excluded from `final` when OFF too; that is one line in pipeline.py.

### Choices I made

- **F1, the `apply_r1(..., notes_only=False)` contract.** It returns an unchanged deep copy, so R1 off is the base behaviour. `run_consult` does not call `apply_r1` when OFF.
- **F2, what R1-1 matches.** NFKC first. Brackets, braces, every Ps/Pe except `(` `)`; the dict/list repr shapes `'k': v`, `"k": v`, `{'`; `<word>`; `__`; `TBD` in any case; **`XX` in capitals only (2 or more X's as a whole word)**. A case-insensitive `xx` matched `test_mapper::test_advice_char_cap`'s `"x" * 200` filler; the brief writes `XX`. Then the missing-value words; then `_D1`, `_d4` and `_D5`, imported from validate.py. `_d4` takes the "Medication" section for medicines and "" elsewhere.
  - Side effect the lead should know: `_D1` reads `unknown` / `unclear` / `not known`, and the brief's word list includes `unspecified`. Clinical labels such as "fever of unknown origin" or "hypertension, unspecified" are therefore withheld wherever they post. This is as specified; nothing was narrowed.
- **F3, how R1-1 withholds.**
  - An optional field is removed. An alias is removed from its list, and an emptied `aliases` key is dropped.
  - A required field (`name`, `raw_name`, `diagnosis_or_impression`, `speciality`) takes the whole row out. A medicine row goes to pick_drug; other rows are renumbered by `_drop_rows`, a generic copy of the same renumber logic. An emptied surgery list sets `requires_surgery_or_procedure` to False (FRX-PR1).
  - A scalar section is removed and its owner is kept out (json_pointer null, discussed_only). An emptied `follow_up` is dropped.
  - Removing `diagnoses[0]` leaves the next diagnosis without `is_primary`, so FRX-D1 rejects the artifact. I did not promote another diagnosis to primary.
- **F4, the withheld provenance item.**
  - item_id `r1w<n>`; text `<section> withheld (placeholder)`. Section is the list key (`medicines`, `diagnoses`, `further_investigations`, …), the scalar key (`examination`, `general_advice`, `symptoms`, `management_plan`), or `follow_up`.
  - It copies the owner's evidence (heard_in_room) when the owner was heard; otherwise it has no evidence and is not_said_in_room.
  - **Confidence is 0.6**, because below 0.6 the v0.3 schema requires `low_confidence`, and the brief wants a single new flag. Flags are exactly `["field_withheld"]`.
- **F5, the R1-2 renumber helper.** I used `recover._demote_medicine`, the artifact-level helper. It pops the row, nulls the owner pointer, sets discussed_only, empties `names` and shifts later pointers. It is the twin of the Builder-level `mapper.Builder._forget_medicine_rows`. Removals run highest index first.
  - A drug with no owner gets a `recover._kept_out` item.
  - The pick_drug entry is `{"kind": "pick_drug", "item_id": <the kept-out owner>, "prompt": "Name this drug", "detail": <name>}`. The prompt is the mapper's own. The detail falls back to raw_name, then `unnamed drug`, when the name itself is a placeholder.
  - R1-2 leaves the owner text unchanged. R1-3 replaces it with `<name> (dose not on tape)`.
- **F6, R1-2 matching.**
  - Drug words: the letter runs of 3 or more letters in name, raw_name and aliases, minus units, dosage forms and joiners (`_NAME_STOP`). Only `speaker == "doctor"` entries count, through `quote_en` or `quote`; `quote_native` does not count.
  - Prefix fallback: **both** words 6 or more letters with the same first 5 letters. "Both ways" means either word may be the longer one.
  - Known gap: a doctor quote that mentions the drug only in Devanagari will not match. That drug goes to pick_drug, which is the fail-safe direction.
- **F7, R1-3.**
  - The number-word helper is `guard.numerals` (`NUM_WORDS`, plus `NUM_WORDS_HI` on non-English quotes). Both the field and the quotes are expanded, and the field's `\d+` runs must be a subset of the quotes' runs. A field word ("two") is checked against a quote digit, and the other way round.
  - Evidence of any speaker counts, because the brief says "that medicine's evidence quotes".
  - `strength` is not a gp_extraction medicine field in v0.3; it is checked only when present.
  - The failing field is popped before the drug moves, so it never posts.
- **F8, R1-4 mechanics.**
  - `medication_floor` replaces only the Medication block (heading line and its continuation lines, found the way `_split_sections` finds them). Every other line stays byte-identical. A note with no Medication heading is rebuilt through `_split_sections` / `_assemble`.
  - My first version rebuilt the whole note through `_assemble`. That broke three existing sanitize tests (it moved a `[S1] General Advice` line), so I changed it.
  - The floor applies to: the deterministic fallback; a kept LLM note (applied after that note passes, then checked again, falling back to the deterministic note if it now fails); the recovery re-render. The repair path is already deterministic for Medication, since `repair_note` takes LIST_HEADS from `render_note`.
  - Applying the floor to the LLM note *before* the first check filled an intentionally empty Medication section and skipped repair, which broke `test_m4`'s premise for the wrong reason. That version was dropped.
  - Guard: if a drug R1 moved to pick_drug is named anywhere in the final note (`V.same_drug`, line by line), the deterministic fallback replaces the note when it clears that. `r1_4_pick_drug_in_note` counts what is left.
  - Offline, `apply_r1` on a stored artifact that has a note rewrites only its Medication section. Other sections are not re-rendered, so a withheld field or a carried red-flag line is not reflected in an old note.
- **F9, the log.** `log["r1"]` is written only when R1 acted (any counter non-zero apart from `notes_only` and `r1_5_no_turns`), the same idiom as `sanitize_removed`. A consult R1 does not touch keeps a byte-identical validation log. This is what makes `test_stage_a_from::test_p1_off_is_old` pass unchanged: R1 acted on 0 of its 200 generated consults.
- **F10, R1-5.**
  - `RED_FLAG_PATTERNS` has 4 regexes covering the class: come back now; go to emergency / casualty / ER / A&E; if worse / increases / does not settle / severe … come back, return or go to hospital; rush to hospital.
  - Clause = the matching sentence of the doctor turn.
  - Covered when the clause's tokens (stop words removed) overlap ≥ 0.6 with any `general_advice` item or any advice-kind provenance text (kept-out ones included, `[tag]` prefix stripped), or when an advice item cites the same segment_ref.
  - The trim is at a word boundary, ≤ 200 characters.
  - Blocked (counted, not added) on R1-1, printable_errors or the FRX-A1 limits (300 characters, 5 items).
  - Quarantined turns are skipped: they belong to another patient. Non-English turns are judged by `lang` (`en` or `en-*`).
  - Turns may be `ingest.Turn` or dicts. For dicts, role comes from `role`, else `speaker` when it is a role word.
  - The new item is `advr1_<n>`, prescribed, json_pointer `/general_advice`, flags `[]`, one doctor evidence entry and a doctor decision.
- **F11, the env switch.**
  - `pipeline.Options` had no env-read fields; the only existing pattern is `nightly.flag_enabled` for `ETA_FREESCRIPT`. `notes_only_enabled(env)` mirrors it: `1/true/yes/on` is on; `0/false/no/off` is off; **unset or empty is on**; anything else raises `NightlyError`.
  - It is read where Options is built, at `nightly._default_run` and `nightly._bundle_runner.run_one`, and checked once in `load_config` so a bad value fails at start-up.
  - Empty means on deliberately (`flag_enabled` treats empty as off): an empty value must not switch the floors off.
- **F12, the commit trailer.** The brief asks for `Co-Authored-By: Claude Sonnet 5.5`. The model that wrote this code is claude-opus-5-5, so the trailer says Opus 5.5. Change it if the lead's records need otherwise.
- **F13, the branch.** The session's configured branch is `claude/frx-r1-notes-floors-cm0j5u`. The cloudpane rule and the brief restrict pushes to `cloudpane/cloud-frx-r1-build/*`, so everything is on `cloudpane/cloud-frx-r1-build/r1` and nothing was pushed anywhere else. No PR.
- **F14, the oracle tests depend on git history.** They import base `3cdb7c0b` with `git archive`, as `test_stage_a_from` already does, and skip if that commit is absent. CI uses fetch-depth 0. Together they take about 5 to 7 minutes.

## 6. `apply_r1`

```python
def apply_r1(art: dict, turns: list | None = None, notes_only: bool = True) -> tuple[dict, dict]
```

It works on a deep copy and never mutates `art`. Order: R1-1, R1-2, R1-3, R1-5, then R1-4 on `note_text` when the artifact already has a note (offline replay). `turns=None` skips R1-5 (`r1_5_no_turns = 1`). Counters dict (all ints, plus one bool):

```
notes_only               bool, as passed
r1_1_withheld            fields withheld (one field_withheld provenance item each)
r1_1_rows_removed        list rows taken out because a required field was withheld (medicines among them went to pick_drug)
r1_2_moved               medicines moved to pick_drug: name not on tape in a doctor span, or not heard_in_room
r1_3_fields_removed      dose fields removed because a digit run was not on tape
r1_3_moved               medicines moved to pick_drug by R1-3
r1_4_note_rewritten      1 if apply_r1 rewrote a stored note's Medication section
r1_4_label_kept          1 if the label line is in the note (0 today, see B2/B3)
r1_5_detected            red-flag clauses found in English doctor turns
r1_5_covered             of those, already covered by advice
r1_5_added               advice lines added
r1_5_blocked             lines not added: R1-1, printable_errors or FRX-A1 limits
r1_5_non_english_skipped doctor turns skipped as non-English
r1_5_no_turns            1 when turns is None
```

`run_consult` adds `r1_4_pick_drug_in_note` to `log["r1"]` when the guard in F8 ran.

Offline replay: `from tools.eta2freescript.r1_floors import apply_r1`, then `new, counters = apply_r1(json.load(open("artifact.json")), turns)`, where `turns` is a list of dicts with `idx`, `role`, `text` (or `quote_en`), `lang`, and `t0_ms`/`t1_ms` (or `t0`/`t1` ISO strings).

## 7. SQL

None. No SQL was written or run, and no database was touched.
