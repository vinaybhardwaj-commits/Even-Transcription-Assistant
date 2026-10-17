# FRX-R4 build report: fable's R4 order and addendum on FRX-R3-VERDICT

Handle cloud-frx-r2-build. Branch `cloudpane/cloud-frx-r2-build/r4`, made from r3 `848d9077` (code `1dc901e0`).
Code commits: `eda751f3` (rulings 1-6) and `e934a512` (addendum 7-9). This report's commit also adds one test (Y12, see Mutants). Model serving this build: `claude-opus-5-5`.
**Verdict: built. Every gate line is green and every ruling target is met.** Line numbers below are `r1_floors.py` at `e934a512` unless another file is named.
## Rulings 1-6
1. **G1**, lines 363 and 560-567.
   - PREFIXES gains `s` and `r`. The next-drug refusal skips `_JOIN` words (`+`, `&`, `/` already read as "and" via `_alnum`).
   - One exception (my choice): the partner after the joiner is not refused when it is another medicine in the same consult (`others`, lines 599 and 793-795). So "Take paracetamol and amoxicillin" still posts both.
   - h6 HELD F3/F6 false accepts: **2/20 -> 0/20**.
2. **G2**, lines 662-670 and 689.
   - In the scan, a known name counts bare, as its whole phrase ("Met", "Pause", "calcium", "B complex").
   - A known name with a form word needs that word too ("fever tablet"), else "Viral fever" would be withheld. The strength/form rule stays for posting only.
   - h8: "continue Met" and "continue Pause" visible: **2 -> 0**.
3. **G3**, lines 712-736 and 738-786.
   - Withholding is per item. `_withhold_items` splits on "; ", newlines and sentence ends, removes only the items that name an unresolved drug, and keeps every other item and its separator as written. Each removed item gets one `field_withheld` "(unconfirmed drug)" provenance item.
   - The whole field is still withheld only when every item goes, or when the string is a list row's required name.
   - `is_warning`: a stop / avoid / do-not-take / allergy / "had a reaction" item passes the scan, unless it also carries a use cue ("Stop amlodipine and start telmisartan" is scanned).
   - Posting still refuses these clauses (`_NOT_USE`, line 572). h3 SAFE-ADV kept in note **0/4 -> 4/4**, posted 0/4; h3b MULTI keeps all 3 items.
4. **G4**, lines 365, 447, 614 and 689.
   - `sitz`, `sunscreen`, `saline` in `_NOT_DRUG`; `NON_RX` = {ors, electral, calamine} pass the scan and never post. h6 OW plain corpus **7/103 -> 0/103**.
   - h9: General Advice lost 5/5 -> **0/5 whole-line losses**. In the one case that names an unposted drug ("Hypertensive on telmisartan, continue own medicines; Drink warm water"), only the telmisartan item goes; "Drink warm water" survives.
5. **G5**: tests in `tests/test_r3_fixes.py`.
   - `test_r4_g5_y6_a_split_misspelt_name_is_joined` (line 246) uses "parace temol": neither half is a drug word, so only the two-word join finds it.
   - Building that test exposed a real gap: "para cetemol" was never joined, because "para" is itself a lexicon word. Line 680 adds a join for that case.
   - `test_r4_g5_y10_pipeline_rejects_a_note_that_still_names_an_unposted_drug` (line 252) patches the deterministic note to name Azee. It asserts `written` is False and that the error is `FRX-R1 note_text names a drug that is not posted`.
6. **L1**: no widening of the scan to unnamed history drugs, per the ruling. h7 is unchanged: 108/113 generics and 78/85 brands found; warfarin, insulin, thyroxine, penicillin and progesterone are not scanned. A future widening would withhold history lines such as "on warfarin, INR 2.5".
## Addendum 7-9
Measured with `m789.py` / `m7b.py` (new harness in my scratchpad, synthetic): before is R3 `1dc901e0`, after is R4 `e934a512`.
7. **Brands**: lines 441-445 and 499.
   - Twelve brands checked: Benadryl, Sumo, Combiflam, Crocin, Disprin, Volini, Moov, Vicks, Zandu, Digene, Eno, Gelusil.
   - Vicks and Eno are not in the lexicon, so they join `OTC_BRANDS`. Bare scan, no known names: **10/12 -> 12/12** found.
   - Pipeline, said by an unknown speaker and named in the LLM note: visible 0/12 -> 0/12, posted 0/12 -> 0/12. R3 already caught them through Stage A's brand_as_said.
   - Sumo, Moov, Eno and Vicks are name-like, so they join `SHORT_BRAND_SEED` and post only with a strength or form word on tape. Posting on "Take X as advised": **4/4 -> 0/4**.
8. **Dose self-correction**: lines 807-841.
   - `CORRECTION` cues (no wait, sorry, I mean, make it, actually, no no, rather, scratch that, change it to, correction). `retracted()`: a number said before the last cue and not after it is taken back.
   - A dose field or a name carrying a retracted number sends the drug to pick_drug through the R1-3 path. The mapper often puts the strength in the name ("paracetamol 1000 mg"), and that case is now covered.
   - The corrected-away strength posted, over 6 patterns (the brief's plus sorry, I mean, make it, actually, no no): **6/6 -> 0/6**. End to end, 1000 posted: **1/1 -> 0/1**.
   - The final dose still posts (`test_r4_8_*`, lines 300-325). Cost: a correction about duration also withholds a frequency said before the cue (fail-safe).
9. **Unfamiliar words**: line 499.
   - On 20 clean notes (set in `test_r3_fixes.py::UNFAMILIAR`, the brief's 5 included), whole-note rejections are **0/20 -> 0/20**.
   - Diagnosis and exam kept: **19/20 -> 20/20**. On R3, "Depigmented patches" lost its exam section, because "patches" was one edit from the lexicon brand "Patchex".
   - Fix: an inflected plain word (-s, -es, -ed, -d, -ing, -ly on a plain stem) never fuzzy-matches. Even on R3 only that section was held back.
## Refuter harness h1-h9 (the verdict branch, unchanged), R3 `1dc901e0` -> R4 `e934a512`
| Harness line | R3 | R4 |
|---|---|---|
| h1 OFF 500, each of note/artifact/calls/written/final_errors/log/files | 500/500 | **500/500** |
| h1 ON written / G1 pointer clash | 500 / 0 | **500 / 0** |
| h1 ON floors: check errs, posted_hits, printable_errs, brackets | 0,0,0,0 | **0,0,0,0** |
| h1 doctor-confirmed drugs written | 413/413 | **413/413** |
| h2_d3 D3 600: visible in note / in posted gx | 0 / 0 | **0 / 0** (written 600/600) |
| h2_d3 D3-sec (13) and D3-qual (8) visible | 0 / 0 | **0 / 0** |
| h2_d3 OW (9 everyday-name moved drugs): fields withheld | 1 (ORS) | **0** |
| h2b mapper pick_drug visible | 0 | **0** |
| h3 GEN-D3 visible / moved | 0/232 | **0/232** |
| h3 SAFE-ADV kept in note | 0/4 | **4/4** (posted 0/4) |
| h3b MULTI advice | red flag only | **all 3 items kept** |
| h4 D5 7 / own 20 / legit recall | 0/7, 0/20, 16/16 | **0/7, 0/20, 16/16** |
| h4 L2 dangerous 16 / own 40 / split 6 | 0, 0, 0 | **0, 0, 0** |
| h4 red flags / neg 10 / routine 16 | 14/14, 0, 0 | **14/14, 0, 0** |
| h6 HELD F3/F6 false accepts | 2/20 | **0/20** |
| h6 HELD recall | 19/20 | 19/20 (miss: "Don't skip the amlodipine 5 mg", fail-safe) |
| h6 HELD red flags / non-red | 10/10, 0/10 | **10/10, 0/10** |
| h6 OW plain corpus withheld | 7/103 | **0/103** |
| h7 coverage generics / brands | 108/113, 78/85 | 108/113, 78/85 (ruling 6) |
| h8 Met / Pause visible | 2 | **0** |
| h8 ORS visible | 0 (withheld) | 1, by ruling G4 (passes the scan, never posted) |
| h9 General Advice line lost | 5/5 | **0/5** (only the telmisartan item goes) |
## Mutants (refuter's `mutants_r3.py`, unchanged, on a worktree of e934a512)
Each mutant's first failure, quoted. 11/12 killed on e934a512. Y12 survived and is killed by a test added after e934a512 (bottom line).
- Y1-Y5 KILLED: `test_f3_split_spelling_does_not_post[ofloxacin-…]`, `[amoxicillin-…]`, `test_f4_stop_or_avoid_mention_does_not_post[ibuprofen-…]`, `test_f6_everyday_brand_needs_strength_or_form[Mox-…]`, `test_r4_g5_y6_a_split_misspelt_name_is_joined`.
- **Y6 two-word join off: KILLED** | `test_r4_g5_y6_a_split_misspelt_name_is_joined` (R3: SURVIVED, 461 passed)
- Y7-Y9 KILLED: `test_f7_moved_qualifier_drug_withholds_the_advice[Calcium]`, `test_d3_scan_finds_generic_brand_abbreviation_misspelling_…`, `test_f5_no_g1_pointer_clash_on_200_generated_consults`.
- **Y10 pipeline keeps a note naming an unposted drug: KILLED** | `test_r4_g5_y10_pipeline_rejects_a_note_that_still_names_an…` (R3: SURVIVED)
- Y11 PCM abbreviation dropped: KILLED | `test_r2_fixes.py::test_d3_moved_drug_never_visible_in_600_runs`
- Y12 R1-5 before the allowlist: SURVIVED on e934a512 (`509 passed`): G3 keeps the warning advice, so the old F4 test no longer depends on the order. Fixed by a test only, `test_r4_f4_order_red_flag_inside_a_withheld_item_is_carried` (one item names Brufen and holds the red flag): `1 failed` with Y12, passes unmutated.
## Gate
- FULL suite, Python 3.11.17, `-n 3` (on the final code e934a512): `4106 passed, 2 skipped in 930.34s`, 0 failed.
- `build_v02 --check`: `v0.2 schema up to date`. `build_v03 --check`: `v0.3 schema up to date` (exit 0).
- Vendored validator on the w38 examples: `OK ex1-fever-patient-own-drug.json`, `OK ex2-negation-no-antibiotic-no-xray.json`, `OK ex3-stopped-glimepiride.json` (exit 0).
- py_compile, Python 3.10.20, on the changed files (`r1_floors.py`, `test_r2_fixes.py`, `test_r3_fixes.py`; `pipeline.py` too, unchanged in R4): OK.
- gitleaks 8.30.1 `detect --no-git` on the changed files: `no leaks found`.
- Tests: only my R2/R3 files changed. `test_r2_fixes.py`: 1 line (per-item G3 keeps "Drink warm water"). `test_r3_fixes.py`: 2 R3 F4 tests changed (a warning now stays, G3), plus new tests for every R4 item. No base or R1 test file touched.
## Flags
1. G1 exception (mine): a joiner partner that is another medicine of the same consult is not refused. Without it, "paracetamol and amoxicillin" would move both drugs.
2. G3 keeps "Do not stop aspirin before the procedure" as a warning (the ruling's 4 examples). It is a continue-instruction, but it never posts.
3. Addendum 8 is fail-safe in a broad way: any number before a cue that is not repeated after it is retracted.
- No SQL, no database, no patient data. All fixtures are synthetic.
