# FRX-R3 build report: fable's R3 order on FRX-R2-VERDICT
Handle cloud-frx-r2-build. Branch `cloudpane/cloud-frx-r2-build/r3`, from r2 `9c5d3dea` (base R1b `ea2818ee`). Code `1dc901e0`.
Model serving this build: `claude-opus-5-5`. **Verdict: built; every gate line green; every order target met.**

## Design change (core: F1 + F2 + F7 + L2)
The R2 blocklist is deleted (`guard_names`, `GUARD_ALIASES`, `moved_in_note`). R1-2b is now an **allowlist** (`r1_floors.py`):
- `vocab()` reads `data/drug-lexicon.json`. Strong drug words come from three sources:
  - each row's first word (the brand or the molecule);
  - `medication_safety.GENERICS` / `BRANDS`;
  - any later word with a molecule suffix.
- It drops plain words: common-English, clinical-English, clinical terms and analytes, a Hindi-romanised list, instruction words and clinical-suffix words.
- `drug_mentions` finds:
  - strong words;
  - an edit-distance-1 match on 6+ letters ("paracetemol");
  - two-word joins ("para cetamol", "para-cetamol");
  - letter-strength codes ("P-650");
  - Stage A's own names, which `pipeline.py` passes in: rx row generic, brand_as_said, _heard_name, and drug history;
  - every medicine provenance item's names, so the mapper's own held and pick_drug drugs are included (F2);
  - qualifier-only known names by whole phrase ("calcium", "vitamin D3": F7).
- `unposted()` keeps only the mentions that do not resolve to a posted, tape-supported medicine. A posted medicine resolves through its own names and molecules and through same-molecule brands. Every unresolved mention counts as a moved drug.
- `r1_allowlist` withholds the whole field that names an unresolved drug: one `field_withheld` item, "(unconfirmed drug)", never characters.
- `pipeline.py` scans the final note with `unposted_in_note`. If the note fails, the deterministic note is tried; if that fails too, the write is rejected (`FRX-R1 note_text names a drug that is not posted`).

## Before (R2 9c5d3dea) / after (R3 1dc901e0), on the refuter's own harness (verdict branch, unchanged)
| Finding | Harness line | R2 | R3 |
|---|---|---|---|
| F1 | h3 GEN-D3, 300 runs: drug visible / moved | 83/232 | **0/232** |
| F1 | h2_d3 D3, 600 runs: visible in written note / in posted gx | 0 / 0 | **0 / 0** (written 600/600) |
| F2 | h2b, mapper-made pick_drug visible | 42 | **0** |
| L2 low | h2_d3 D3-sec misspelt / split / P-650 / other molecules visible | visible | **0/13** |
| F3 | h4 split spellings posted | 6/6 | **0/6** |
| F4 | h3b MULTI: red flag in note after advice withheld | lost | **kept** (`r1_5_added=1`) |
| F5 | h1 ON G1 pointer clash, seeds 1000-1499 | 116/500 | **0/500** (written 384 -> **500/500**) |
| F6 | h4 D5 own: posted (Pan 40 on "Pan masala stop.") | 1/20 | **0/20** |
| F7 | h2_d3 D3-qual moved calcium / zinc / iron visible | 3/3 | **0/3** (vitamin D3, magnesium, KCl, folic acid also 0) |
| L1 | h4 D5 legit recall ("Calcium with vitamin D3") | 15/16 | **16/16** |
| L3 | h4 red flags fire | 11/14 | **14/14** |
| L3 | h4 negated / routine sets fire | 0/10, 0/16 | **0/10, 0/16** |
| D5 / L2 | h4 verdict 7, dangerous 16, own 40 | 0, 0, 0 | 0, 0, 0 |
| Over-withholding | h2_d3 OW, 9 everyday-name moved drugs: fields withheld | (R3 draft: 13) | **1** (ORS advice: ORS is the moved drug) |
| D1 | h1 OFF vs base 3cdb7c0b: note, artifact, calls, written, final_errors, log, files | 500/500 | **500/500** each |
| Floors | h1 ON written: check() errs, posted_hits, printable_errors, brackets | 0 | **0** |
| Recall | h1 doctor-confirmed drugs written | 313/413 | **413/413** |

## Per item, what changed
- **F3** (`name_in_text(use=True)`): the match is refused in three cases:
  - the word before the name is in `PREFIXES` (hydroxy, methyl, levo, es, dex, des, nor, chlor);
  - the word before joins with the name into a strong drug word;
  - the word after it is another drug not in the medicine's own words ("amoxicillin clavulanate").
- **F4**:
  - Order is R1-1, R1-2, R1-3, R1-2b, then R1-5.
  - R1-5 counts as "covered" only by POSTED advice; a withheld owner no longer covers it.
  - A match in a stop / avoid / negated clause never posts (3 words before, or "not / no / stop / avoid" just after). It still withholds, as ordered. h3 SAFE-ADV: "Avoid ibuprofen …", "Stop metformin …" and "Do not stop aspirin …" remain withheld, which is the ruling.
- **F5**: the R1-5 item has `json_pointer` null with status `conditional` whenever an advice owner exists. The schema allows null only with a non-posting status. With no owner, the item IS the owner (`/general_advice`), because FRX-A1 needs one; that case cannot clash. See flag 1.
- **F6**: `vocab().everyday` is lexicon first words that are common-English or Hindi words, plus the seed Pan / Mox / Dolo / Azee / Zinc.
  - Such a brand posts only with a strength (not a duration: "Fever (2 days)" no) or a form word next to it on tape, or with its own full name ("Pan D").
  - The scan uses only the seed and known names, so "reduce salt to 5 g" is never withheld.
- **L1**: "+", "&" and "/" join; a lone-qualifier component counts inside a 2+ component combination. A lone "Calcium" still never posts.
- **L3**: back as cues:
  - `drows*`;
  - "bring / take him to casualty";
  - "not better / improving";
  - "(it | fever | pain | vomiting | bleeding | swelling | symptoms) continues / persists".
  - NEGATION still guards all of them.

## Gate
- FULL suite (Python 3.11.17, `-n 3`): **4058 passed, 2 skipped, 0 failed** in 1135.69s. It was 4009 at r2; +49 in `test_r3_fixes.py`.
  - One earlier run had 1 failure, `test_bundle_ingest::test_timeout_kills_the_whole_process_group`. That is a timing test in a file R3 does not touch. It ran while h1 loaded the CPU, and it passes alone and in the final run.
- `build_v02 --check` / `build_v03 --check`: up to date, exit 0. Vendored validator on the 3 w38 examples: OK x3.
- py_compile, Python 3.10.20, on the 4 changed files: 4/4 OK. gitleaks 8.30.1 on the 4 changed files: no leaks found.
- Tests:
  - `test_r3_fixes.py` is new.
  - `test_r2_fixes.py`, R2's own file, is edited (flag 2).
  - `test_r1_floors.py` and the base test files are untouched since r2.

## Flags for fable
1. F5 is met (0/500), but not by "always null". `prescribed` + null fails the schema, and a lone red-flag line needs an owner for FRX-A1.
2. `test_r2_fixes.py` edits, all forced by the order:
   - the blocklist API tests became scan tests;
   - a Dolo 650 posted beside a moved paracetamol now stays (it is posted and tape-supported);
   - 2 routine sentences that L3 makes fire were reworded.
3. `DRUG_ABBREVIATIONS = {"pcm"}`: no lexicon row has PCM, and it only widens the scan.
4. Safety advice that names an unposted drug is withheld whole (h3 SAFE-ADV, 4/4), as ordered. Withholding one "; " item instead is fable's to rule.
5. `Pan D` posts on "Pan D before food" (full brand name). A bare "Pan" never posts without a strength or form word.
- No SQL, no database, no patient data. All fixtures are synthetic.
