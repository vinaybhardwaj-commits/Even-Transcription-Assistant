# FRX-R1b build report: lead rulings B1-B4 and F2 on the FRX-R1 build

Handle: cloud-frx-r1b-build. Branch: `cloudpane/cloud-frx-r1b-build/r1b`, made from `cloudpane/cloud-frx-r1-build/r1` (head 1e4d660b, code 2e4a51e5, base 3cdb7c0b).
Model serving this build: `claude-opus-5-5` (`get_session`: `session_context.model` and `last_served_model` both `claude-opus-5-5`).

**Verdict: built, all gate lines green.** Code commit `ea2818ee` (ea2818eef4631e11b01509aa2b7e3d39379d62bb). This report and the OUTBOX line are the next commit.

## 1. What changed, ruling by ruling

- **B1.** `test_sanitize_span_reject.py`: `_run_a` takes an optional `opts`; `test_m4_repaired_llm_note_that_loses_a_span_is_not_kept` now passes `Options(notes_only=False)`. Its assertions are unchanged; none was deleted or weakened. New test `test_m4_r1_on_withholds_the_bracketed_instruction_at_source` (`Options(notes_only=True)`) asserts: `r1_1_withheld >= 1`; no bracket or "today" left in any further_investigations entry; a `field_withheld` investigation provenance item; no `[`/`]` in note_text; no "today" on the Further Investigation lines; no FRX-L1 in final_errors; final_valid.
- **B2.** `note.MEDICATION_LABEL = "Draft list, not a prescription; the treating doctor checks each drug."`. `printable_errors` returns `[]` with and without a drug line after it (pinned).
- **B3.**
  - `r1_floors.notes_only_note` always puts the label first under Medication when a drug posts. The R1 fail-closed check is gone. No drug means no label and an empty Medication section.
  - `validate._unlabelled(note)` (new, 14 lines) drops only the exact line `Medication: <label>`. A drug line that follows moves up onto the heading, so the result is byte-equal to the unlabelled floor.
  - It is used in three places: `_expanded_note` (so `to_v01`, and through it vendored G6), `_c_rules` (C4) and `frx()` FRX-C2. The vendored validator is untouched (verified: `git diff` on `vendor/` is empty).
  - The label is never a gp_extraction medicine. `artifact.v0.1.json` carries no label: its note has one Medication line per drug, and vendored `V.check` on it returns `[]`.
  - Choice C1: I skip the label in the v0.1 projection itself, not only inside `check()`. Otherwise `artifact.v0.1.json` would fail the vendored G6 that its consumers run. If the lead wants the label in the v0.1 note too, it is one line in `_expanded_note`, but that file would then fail vendored G6.
- **B4.** `pipeline.py`: `final = note_errs(check(art)) + span_errors(llm_rem)`. With OFF, FRX-G1 no longer gates the write. With ON, nothing changes.
- **F2.** `r1_floors.withhold_reason`:
  - Placeholders (brackets, reprs, `<slot>`, `__`, TBD, XX, d5 markers) still withhold anywhere in the value.
  - The missing-value words (`_MISSING`, validate's `_D1` and `_d4`) now withhold only a missing-value statement: the whole value, a sentence of it (split on `;`, `.`, newline), or a comma clause with its own subject ("BP not specified", "dose unknown"). Label prefixes are stripped first (`dose: not specified`).
  - A bare missing word after a comma qualifies the item before it, so it posts ("hypertension, unspecified"). So does a missing word inside a phrase ("fever of unknown origin", "pain of unclear aetiology").
  - FRX-G1 reads the same function, so it agrees.
- The R1 tests that encoded the overturned behaviour were updated to the rulings, not deleted:
  - `test_r1_1_every_pattern…` and the property test inject missing-value patterns as their own clause; the independent oracle checks that no posted sentence is exactly a missing-value pattern.
  - `rhinitis, unspecified` became `unspecified`.
  - The two "label kept out" tests became label-kept tests, and `r1_4_label_kept` is now 1 in the pipeline test.

## 2. Files

- `tools/eta2freescript/note.py` (label wording, docstring)
- `tools/eta2freescript/pipeline.py` (B4, one line plus docstring)
- `tools/eta2freescript/r1_floors.py` (F2, notes_only_note)
- `tools/eta2freescript/validate.py` (`_unlabelled` plus its 3 call sites; nothing else)
- `tools/eta2freescript/tests/test_r1_floors.py`
- `tools/eta2freescript/tests/test_sanitize_span_reject.py`
- Outside the code commit: this report and `cloudpane/cloud-frx-r1b-build/OUTBOX.md`.

## 3. Gate and test counts

| Gate | Result |
|---|---|
| Full suite: `python -m pytest -c tools/eta2freescript/pytest.ini tools/eta2freescript/tests -n 6` (Python 3.11.17, fresh venv) | **3954 passed, 2 skipped, 0 failed** in 965 s. R1 was 1 failed, 3895 passed, 2 skipped. |
| test_r1_floors + test_sanitize_span_reject | 628 collected (R1: 570). 2 R1 tests replaced, 60 added (net +58): B1 1, B2 1, B3 3, F2 55 (15 qualifier cases, 40 withheld cases) |
| `schema.build_v02 --check` / `build_v03 --check` | up to date / up to date |
| vendored `validate_artifact.py vendor/freescript-w38/examples/*.json` | OK x3 |
| gitleaks v8.30.1 `detect --no-git` on a copy of the 6 changed files | no leaks found |

npm, swift and `check:silent` gates: not run. This brief touches only `tools/eta2freescript` (Python) and this sandbox has no Mac toolchain.

## 4. OFF proof (B4), same 200-consult generated set (`gen_consult`, seeds 0-199, FakeClient)

`test_r1_4_off_is_byte_identical_to_base` runs base `3cdb7c0b`'s `run_consult` (from git archive) against this build with `notes_only=False`. In all 200 consults it asserts these are identical:
- note_text and the artifact (volatile ids and times aside);
- model calls;
- the whole validation log minus timings;
- final_errors and written;
- for each of artifact.json, artifact.v0.1.json and artifact.rejected.json: present on both sides or neither, with identical content.

Printed: `200 consults, note, artifact, log and write decision identical; written 200; flips 0; FRX-G1 would fire on 49 (excluded OFF)`. The 49 written->rejected flips are back to 0. The test asserts `flips == 0` and that FRX-G1 does fire on the set, so the proof is not vacuous.

ON recorder (`test_r1_4_on_changes_only_stage_b_input`): `200 consults; Stage A identical in all; Stage B input identical 80, changed by R1 120; drugs moved 96; r1_4_label_kept 107; written 161`. It asserts, per consult, that the label is present exactly when a drug posts and that `r1_4_label_kept == int(posted)`; overall `labels > 0`. Every written consult's v0.1 note has no label.

## 5. Mutation check (each mutant on a throwaway worktree, targeted tests, first failure quoted)

| Mutant | Result |
|---|---|
| B1 notes_only ignored (R1 always runs) | KILLED by `test_m4_repaired_llm_note_that_loses_a_span_is_not_kept` |
| B1 R1-1 lets a bracket post | KILLED by `test_m4_r1_on_withholds_the_bracketed_instruction_at_source` |
| B2 label reverted to the R1 wording | KILLED by `test_r1_4_label_wording_is_the_ruling_and_prints` |
| B3 `_unlabelled` made the identity (no G6/C4/FRX-C2 skip) | KILLED by `test_r1_4_pipeline_drops_model_line_for_a_pick_drug_drug` |
| B3 label not inserted (`label=False`) | KILLED by `test_r1_4_label_is_the_first_medication_line_when_a_drug_posts` |
| B4 FRX-G1 gates the write when OFF | KILLED by `test_r1_4_off_is_byte_identical_to_base` |
| F2 missing words withhold anywhere (the R1 behaviour) | KILLED by `test_f2_clinical_qualifier_posts_unchanged[…diagnoses/0…]` |
| F2 a bare "not specified" / "unknown" no longer withheld | KILLED by `test_f2_missing_value_statement_is_withheld[…diagnoses/0…]` |

8/8 killed. The 5 rulings are covered, with 2 mutants each for B1, B3 and F2.

## 6. Could not do / flags for the lead

- **R1-5 defect (in R1, not caused by R1b, not fixed: out of scope).** With ON, 39 of the 200 generated consults are rejected, every one by vendored `G1 advr1_1: json_pointer /general_advice already claimed by adv2`. R1-5 adds its advice provenance item with `json_pointer /general_advice` when another advice item already owns that pointer. The R1 head (1e4d660b) gives the same 39 with the same reason, so R1b neither caused nor changed it. Fix candidate for R1c: the R1-5 item should cite the existing advice owner, or be kept out (json_pointer null).
- C1 above: the label is also skipped in the v0.1 projection.
- F2 boundary, for clinical review: a subject of 3 words or fewer, followed by a negated missing phrase, is withheld ("allergy history not known"). An adjectival missing word with a non-field subject posts ("hypertension unspecified", "fever, cause unknown").
- No SQL, no database, no patient data. Every fixture is synthetic.
