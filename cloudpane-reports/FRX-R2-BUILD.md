# FRX-R2 build report: fable rulings 4-8 on R1b

Handle: cloud-frx-r2-build. Branch: `cloudpane/cloud-frx-r2-build/r2`.
Model serving this build: `claude-opus-5-5` (`get_session`: `session_context.model` and `last_served_model` are both `claude-opus-5-5`).

**Base: R1b `ea2818ee`** (branch `cloudpane/cloud-frx-r1b-build/r1b`, head `12f57a8e`). This follows fable's REDIRECT. R1b's lead rulings B1-B4 and F2 replace my rulings 1, 2 and 3 (D1, D4, D2). I did not redo them, and I carry none of my earlier D1/D2/D4 changes: validate.py, note.py, the Options default, the label and note_errs are all exactly as in R1b.

**Verdict: built. All gate lines are green.** Code commit `9c5d3dea` (9c5d3deaa7a85150ec4f9d00abd75e9589798071). This report and the OUTBOX line are the next commit.

## 1. Rulings, what changed, file:line

All lines refer to the code commit `9c5d3dea`.

### Ruling 4, D3: a moved drug is never visible. **Met: 0 of 600.**

- `r1_floors.py:437` `guard_names(m, owner_names)`. It covers every name a moved drug can be written under:
  - name, raw_name and every alias;
  - the provenance owner's `names`, read at `r1_floors.py:253` before `_demote_medicine` empties them;
  - same-molecule brands and the generic, from the existing `medication_safety.BRANDS` and `GENERICS` (Dolo 650 -> paracetamol, crocin, dolo);
  - `GUARD_ALIASES` (`r1_floors.py:433`, `{"paracetamol": ("calpol", "pcm", "crocin", "dolo")}`). This is guard-only and widens nothing that posts. See flag F1.
- `r1_floors.py:459` `moved_in_text`: whole-word matching, line by line, with the same tokeniser as R1-2 (`name_in_text`).
- `r1_floors.py:464` `r1_moved_mentions` (R1-2b) withholds every posted gp_extraction string that names a moved drug.
  - It reuses R1-1's withholding (`r1_posted_fields` now takes `hits` / `why` / `key`), so the whole field goes, with one `field_withheld` item whose text is `"<section> withheld (unconfirmed drug)"`.
  - A posted medicine whose name is the moved drug moves to pick_drug as well. It loops until nothing names a moved drug.
  - It runs last in `apply_r1_ex` (`r1_floors.py:701`), after R1-5, before Stage B.
- `r1_floors.py:688` `apply_r1_ex` returns `(art, counters, moved)`. `apply_r1`'s signature and return are unchanged. A stored note_text that still names a moved drug is replaced by the deterministic note.
- `pipeline.py:122-123, 185-201`: the guard is `moved_in_note` instead of `pick_drug_in_note`. If the kept note names a moved drug, the deterministic fallback is used when it clears the guard. Otherwise the write is rejected with `FRX-R1 note_text names a drug moved to pick_drug` (only when ON). The code never keeps such a note.
- Measured on the verdict's setup, rebuilt (`test_d3_moved_drug_never_visible_in_600_runs`). Each run has an unknown-speaker paracetamol, said as the generic, Calpol, Dolo 650, Crocin or PCM. Its LLM note names it, under any of 7 names, in General Advice, Plan of Management or Diagnoses. In 257 runs the posted advice names it too.

| Build | Written | Visible in the written note_text |
|---|---|---|
| R1b `ea2818ee` | 600/600 | **526** (dolo 181, pcm 98, paracetamol 97, calpol 76, crocin 74) |
| R2 `9c5d3dea` | 600/600 | **0** (and 0 in any posted gp_extraction string) |

### Ruling 5, D5: a name on tape needs the base molecule word. **Met: 7/7 now pick_drug.**

- `r1_floors.py:334` `QUALIFIERS` holds the salt, qualifier, vitamin and pack words: acid, sodium, potassium, calcium, chloride, carbonate, vitamin, d3, duo, pack, forte, sr, xr, er, and similar.
- `r1_floors.py:363` `name_phrases`. A name splits into components on and / plus / with.
  - A component with a base word needs that base phrase: "pantoprazole sodium" -> pantoprazole.
  - A component made only of qualifiers needs its whole phrase of 2 or more words: "vitamin D3".
  - A lone qualifier ("calcium") never matches.
- The verdict's 7 cases are folic acid / "acid reflux", pantoprazole sodium / "low sodium", vitamin D3 / "vitamin levels", potassium chloride / "potassium is low", calcium carbonate / "calcium in milk", Augmentin 625 Duo / "Duo pack", and Calcium / "calcium in milk". The verdict names 6 of them; the 7th, a lone qualifier name, is my rebuild. The original 7th is not in the verdict.
  - R1b posts **7/7**. R2 posts **0/7**, so all 7 go to pick_drug.
  - Tested in `test_d5_qualifier_word_alone_goes_to_pick_drug`. The base word on tape still posts (`test_d5_base_word_on_tape_posts`).

### Ruling 6, L2: exact or alias match only. **Met: 0 of 16 pairs match.**

- `r1_floors.py:393` `name_in_text` / `r1_floors.py:401` `name_on_tape`. The R1-2 prefix rule (`word_matches`, `drug_words`) is gone.
  - Matching is exact, on whole contiguous words of the normalised name or a listed alias.
  - Normalising drops strength digits, unit / form / pack words and qualifiers.
- `test_l2_look_alike_never_matches` covers all 16 ordered pairs: prednisolone/prednisone; hydroxychloroquine/hydroxyzine/hydrochlorothiazide; chloroquine/chlorpheniramine/chlorthalidone; amoxicillin/amoxiclav. For each pair it checks three things:
  - `name_in_text` is False;
  - `name_on_tape` is False, and the drug goes to pick_drug through `apply_r1`;
  - the same word, once listed as an alias, does match.
- Result: 0/16 match. Under R1 / R1b, 16/16 matched.

### Ruling 7, L1: negation; R1-5 tightened. **Met: 0/10.**

- `r1_floors.py:529` `_WORSE`:
  - dropped `start \w+ing` and `continues`;
  - `blood` became `blood in` ("if the blood test is normal" no longer counts as a cue);
  - added vomiting, chest pain, seizures and similar.
- The conditional pattern drops bare `return`. It now needs `return here / to us / to the clinic / hospital / emergency`.
- `r1_floors.py:548` `RED_FLAG_CUE`: every sentence must carry a worsening or red-flag cue.
- `r1_floors.py:552` `NEGATION`: no need to / don't need to / not needed / need not / don't have to / don't go, come or rush, etc. It covers only the negated instruction, so "Don't worry, but if it gets worse come back immediately" still fires.
- `r1_floors.py:569` `is_red_flag` and `:576` `red_flag_clauses`: a question never fires ("Go to ER? No, not needed.").
- Measured with R1b's detector (identical to R1's) against R2's:

| Set | R1b (before) | R2 (after) |
|---|---|---|
| The verdict's 10 negated / non-clinical examples (5 quoted in the verdict, 5 rebuilt in kind) | 10/10 fire | **0/10** |
| 16-sentence routine hand set (rebuilt: the verdict does not list its set; on its own set it reported 9/16) | 5/16 | **0/16** |
| 2,000 generated "If X, come back / return ..." sentences (my generator) | 1,414 | 233 (all with a real cue: worse / persists) |

- True red flags still fire (`test_l1_red_flags_still_fire`, 11 cases, including the R1 brief's own sentence).
- **r1b's flag "R1-5 G1 pointer clash rejects 39/200 ON": not touched.** On gen_consult seeds 0-199 with ON, R1b and R2 give the same result: 39 rejected, all 39 by vendored `G1 advr1_N: json_pointer /general_advice already claimed`, and 44 R1-5 lines added. L1 changes which sentences are detected, not how R1-5 posts its provenance item. The clash is still open for an R1c, as R1b reported.

### Ruling 8, L6: kill M2 and M5. **Met.**

Each mutant was run on a throwaway worktree against `test_r2_fixes.py` (`-x`), and the first failures are quoted. 5/5 killed.

| Mutant | Result |
|---|---|
| M2: a 4-letter prefix fallback re-added to `name_in_text` | KILLED: `test_d5_qualifier_word_alone_goes_to_pick_drug[potassium chloride-…]`, `[vitamin D3-…]`. Run alone, `test_l2_look_alike_never_matches` also fails 16/16 under M2 |
| M5: coverage threshold 0.6 -> 0.5 | KILLED: `test_l6_m5_overlap_half_is_not_covered` |
| D5: qualifiers ignored (base = every word) | KILLED: `test_d5_qualifier_word_alone_goes_to_pick_drug[Calcium-…]`, `test_d5_base_word_on_tape_posts[pantoprazole sodium-…]` |
| D3: R1-2b (`r1_moved_mentions`) removed | KILLED: `test_d3_posted_field_naming_a_moved_drug_is_withheld_whole`, `test_d3_moved_drug_never_visible_in_600_runs` |
| L1: NEGATION removed | KILLED: `test_l1_negated_and_non_clinical_never_fire` |

`test_l6_m5_overlap_half_is_not_covered` pins an overlap of exactly 0.5 as not covered (the line is added). `test_l6_overlap_three_quarters_is_covered` pins 0.75 as covered.

### Rulings 1, 2, 3 (D1, D4, D2): R1b's, not redone. Ruling 9 (L3, L4, L5): no change.

## 2. Gate

| Gate | Result |
|---|---|
| Fresh venv, Python 3.11.17, `pip install -r tools/eta2freescript/requirements.txt pytest pytest-xdist` | installed |
| FULL suite `python -m pytest -c tools/eta2freescript/pytest.ini tools/eta2freescript/tests -q -n 8` | **4009 passed, 2 skipped, 0 failed** in 1197.60s. R1b was 3954 passed; +55 new in test_r2_fixes.py |
| `schema.build_v02 --check` / `build_v03 --check` | `v0.2 schema up to date` / `v0.3 schema up to date` (exit 0; no schema change in R2) |
| vendored `validate_artifact.py vendor/freescript-w38/examples/*.json` | OK ex1, OK ex2, OK ex3 (exit 0) |
| `python3.10 -m py_compile` (3.10.20) on the 4 changed files | 4/4 OK |
| gitleaks 8.30.1 `detect --no-git` on a copy of the 4 changed files | `no leaks found`, exit 0 |
| `git diff --stat` on tests/, against R1b | `test_r2_fixes.py` new. `test_r1_floors.py`: 3 lines in one parametrize, see F2. No base test file touched |

npm, swift and `check:silent` were not run. The brief touches only `tools/eta2freescript` (Python), and this sandbox has no Mac toolchain.

## 3. Files (code commit)

- `tools/eta2freescript/r1_floors.py`: D3, D5, L2, L1.
- `tools/eta2freescript/pipeline.py`: the D3 guard, 19 lines.
- `tools/eta2freescript/tests/test_r2_fixes.py`: new, 55 tests.
- `tools/eta2freescript/tests/test_r1_floors.py`: see F2.

## 4. Flags

- **F1, D3 alias data.** The existing alias data has no Calpol or PCM for paracetamol:
  - `medication_safety.BRANDS` has only dolo and crocin;
  - db13 lexicon rows carry no molecule mapping;
  - a mapped "Calpol" medicine has names ["Calpol"] only.
  So I added `GUARD_ALIASES` in r1_floors. It is used only by the moved-drug guard, to withhold more; it never lets anything post. The lead may want it in medication_safety, or may want it dropped. Measured: with `GUARD_ALIASES = {}`, 296 of the 600 runs stay visible (pcm 119, calpol 88, dolo 41, paracetamol 31, crocin 17). The cause is that a moved "Calpol" medicine has no molecule link in the existing data.
- **F2, existing-test edit (R1's own file, new against 3cdb7c0b).** `test_r1_floors.py::test_r1_2_prefix_fallback_both_ways`: the cases amoxicillin/"amoxil" and amoxil/"amoxicillin" flip from True to False. This is ruling L2 itself: the prefix rule they pinned is removed. Nothing else in that file changed, and no base test file is touched.
- **F3, D3 withholds up front.** R1-2b withholds a posted field that names a moved drug before Stage B. It does not wait for "neither note clears the guard". The deterministic fallback renders posted fields, so that field always fails the guard, and gp_extraction itself is posted. The cost is that a field such as "Continue paracetamol as advised" is withheld even when the LLM paraphrased it out.
- **F4, D3 duplicates.** A posted medicine with the same drug name as a moved one moves too (`test_d3_a_posted_duplicate_of_a_moved_drug_moves_too`). Example: the moved drug is "pantoprazole sodium" and "pantoprazole 40 mg" is posted. This over-moves, which the rulings accept.
- **F5, D5 over-move.** A drug whose whole name is one qualifier word ("Calcium", "Zinc") can never post now. It is always a pick_drug.
- **F6, rebuilt sets.** The verdict does not publish its 16-sentence hand set, its 5 unquoted negated examples, its 7th D5 case or its 600-run script. Mine are rebuilt from its description and are in `test_r2_fixes.py`.
- No SQL, no database, no patient data. All fixtures are synthetic.
