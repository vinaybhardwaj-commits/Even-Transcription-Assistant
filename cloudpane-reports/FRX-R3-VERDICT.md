VERDICT: FAIL (narrow; 3 small fixes away from PASS-WITH-FIXES)

FRX-R3 refute. Handle cloud-frx-r2-refute. Target `cloudpane/cloud-frx-r2-build/r3`, code `1dc901e0` (848d9077 is report only), parent r2 `9c5d3dea`, base `3cdb7c0b`. Synthetic data only. Model serving this refute: claude-opus-5-5.

Every R2 finding is closed on my published harness, and the numbers match the builder's table. R3 was tuned against that harness, so I wrote held-out sets (`h6_heldout.py`, `h7_cov.py`, `h8_plainmoved.py`, `h9_ow.py`; none was visible to the builder). The held-out sets still show two floor breaches: G1 (2 false accepts) and G2 (a moved drug visible). Each needs a one-line fix.

Gate (run by me: Python 3.11.17 venv, git worktree at 1dc901e0):
- FULL suite (`-n 3`): `4058 passed, 2 skipped`, exit 0, in 1393.99s.
- `build_v02 --check` / `build_v03 --check`: up to date, exit 0. Vendored validator: OK on ex1, ex2 and ex3.
- py_compile, Python 3.10.20, on the 4 changed .py files: 4/4 OK. gitleaks 8.30.1 on the changed files: `no leaks found`.
- tests/: `test_r3_fixes.py` is new. `test_r2_fixes.py` is edited, which is R2's own file and is builder flag 2. I accept that, because the blocklist API it tested is gone. No base or R1 test file is touched.

R2 findings, re-run on R3 with my harness:
| Item | Harness | R2 | R3 |
|---|---|---|---|
| D1 OFF vs base, seeds 1000-1499 (note, artifact, calls, written, final_errors, log, files) | h1 | 500/500 | **500/500** each |
| F1 moved drug visible, 15 brand/generic pairs | h3 GEN-D3 | 83/232 | **0/232** |
| D3 600 runs: visible in written note / in posted gx | h2_d3 | 0/0 | **0/0** (written 600/600) |
| F2 mapper-made pick_drug visible | h2b | 42/42 | **0** |
| L2 misspelt / split / P-650 / other brands visible | h2_d3 D3-sec | 11/13 | **0/13** |
| F3 split spellings posted | h4 | 6/6 | **0/6** |
| F4 red flag after withheld advice | h3b MULTI | lost | **kept** (`r1_5_added=1`) |
| F5 G1 pointer clash, ON | h1 | 116/500 | **0/500** (written 500/500) |
| F6 own D5 qualifier cases posted | h4 | 1/20 | **0/20** |
| F7 moved calcium / zinc / iron etc. visible | h2_d3 D3-qual | 6/8 | **0/8** |
| L1 legit qualifier recall | h4 | 15/16 | **16/16** |
| L3 red flags fire / negated / routine | h4 | 11/14, 0/10, 0/16 | **14/14, 0/10, 0/16** |
| Prior D5 7 / dangerous 16 / own 40 pairs | h4 | 0 / 0 / 0 | 0 / 0 / 0 |
| Doctor-confirmed drugs written (base 413/413) | h1 | 313/413 | **413/413** |

Safety floors, R3 ON, seeds 1000-1499, 500 written: 0 check() errors (FRX-M4 dose precedence included), 0 posted_hits, 0 printable_errors, 0 bracket or placeholder in note_text, 0 posted medicine without a doctor name quote, 0 dose digit off tape. R3 against R1b: medicines differ in 0/500; note and written differ in 116/500, which are exactly the 116 F5 rejections that now write.

Held-out results:
- F3/F6 class, 20 new false-accept cases: **2/20 post**, see G1. Recall on 20 new doctor-confirmed cases: 19/20. The miss is "Don't skip the amlodipine 5 mg", where the negation guard over-moves; this is fail-safe.
- Red flags: 10/10 new red flags fire, and 0/10 new non-red sentences fire (L3's new cues, "persists" and "continues", included).
- Scan coverage, "continue <X> as advised" with no known names:
  - 108/113 common OPD generics are found. Missed: warfarin, insulin, thyroxine, penicillin, progesterone.
  - 78/85 brands are found. Missed: met, fluka, pan, fludac, restyl, finpecia, pause.
  - When the drug is a moved Stage A drug, the known-names path still hides 6 of the 8 plain-word or brand-misspell cases, but not G2's two.

Findings:
1. G1 FAIL (look-alike false acceptance, ruling 6). `name_on_tape` posts in two held-out cases:
   - `amlodipine` on the doctor quote "Start s amlodipine 2.5 mg." S-amlodipine is a different product at half the dose. Cause: `PREFIXES` (r1_floors.py:363) lacks "s".
   - `amoxicillin` on "Start amoxicillin plus clavulanic acid 625." This is the dangerous amoxicillin / amoxiclav pair. The next-drug refusal (r1_floors.py:556) checks only the word right after the name, and here that word is the joiner "plus". "amoxicillin clavulanate" is correctly refused.
   - Repro: `h6_heldout.py` "HELD F3/F6".
   - Fix: add "s" (and "r", for r-isomers) to PREFIXES. Skip `_JOIN` words and "+", "&", "/" when looking for the next drug word.
2. G2 FAIL (a moved drug visible; floor: 0 drugs without tape support). The brands "Met" and "Pause", said by an unknown speaker (Stage A generic metformin and paracetamol in my fixture), move to pick_drug. Yet "continue Met as advised" and "continue Pause as advised" stay in the written note. A known name that is a plain word is only scanned with a strength or form word next to it (r1_floors.py:663).
   - Repro: `h8_plainmoved.py`, Met and Pause lines.
   - Fix: in the scan, a moved drug's own known name counts bare. The strength/form rule belongs to posting, not to withholding.
3. G3 HIGH, open ruling (allergy and safety advice withheld; builder flag 4). These posted advice strings are withheld whole, 4/4:
   - "Do not take amoxicillin again; you had a rash with it." (allergy; the amoxicillin was not prescribed);
   - "Avoid ibuprofen because of the stomach ulcer.";
   - "Stop metformin two days before the CT scan.";
   - "Do not stop aspirin before the procedure."
   The red flag is now kept (F4 fixed), but an allergy warning is lost from the note. This follows the order to withhold the whole field, so it is not counted as a breach. Fable to rule: let a stop / avoid / allergy clause pass the scan (the posting side already refuses it), or withhold only that "; " item.
4. G4 MED (over-withholding of non-drug advice). On a held-out set of 103 legitimate complaint, diagnosis, exam, investigation and advice strings with no posted drug, **7/103** would be withheld: "Warm saline gargles", "Sitz bath twice a day", "Saline nasal drops", "ORS solution ...", "Electral powder ...", "Calamine lotion ...", "Sunscreen when outdoors".
   - End to end (`h9_ow.py`): the whole General Advice line is lost 5/5, taking "Drink warm water" with it. "Hypertensive on telmisartan, continue own medicines" is lost the same way.
   - saline, sitz and sunscreen are not drug mentions in this use; ORS, Electral and calamine are OTC products, which is arguable.
   - Fix: put sitz and sunscreen in `_NOT_DRUG`, and saline / ORS / Electral in a non-prescription allow set. Or settle it with G3's per-item ruling.
5. G5 MED (test strength). My mutants Y6 and Y10 survive the full builder suite: the two-word join and the pipeline's final reject are untested. Y10 is the same gap as R2's X10, still open.

LOW:
- L1. History mentions of drugs (warfarin, insulin, thyroxine, penicillin) are not found by the scan when Stage A did not name them. Today they pass through to the note; if the scan is widened, they would be withheld. Note this before any widening.
- L2. `HINDI_WORDS` includes "sona", "raja", "rani", "shanti" and "chandan". Fine for the scan, but it makes those brands "everyday" for posting (strength needed). This is fail-safe.

Mutants of my own on R3's changes (`frx-r2-refute-harness/mutants_r3.py`, run against test_r1_floors.py + test_r2_fixes.py + test_r3_fixes.py, -x). 10/12 killed:
- Y1 "levo" dropped from PREFIXES: KILLED by `test_f3_split_spelling_does_not_post[ofloxacin-…]`.
- Y2 next-drug refusal off: KILLED by `test_f3_split_spelling_does_not_post[amoxicillin-…]`.
- Y3 negated-clause refusal off: KILLED by `test_f4_stop_or_avoid_mention_does_not_post[Pan 40-…]`.
- Y4 everyday-brand adjacency off: KILLED by `test_f6_everyday_brand_needs_strength_or_form[Mox-…]`.
- Y5 fuzzy off: KILLED by `test_d3_scan_finds_generic_brand_abbreviation_misspelling_…`.
- Y6 two-word join off: **SURVIVED** (461 passed).
- Y7 qualifier phrase scan off: KILLED by `test_f7_moved_qualifier_drug_withholds_the_advice[Calcium]`.
- Y8 letter-strength code off: KILLED by `test_d3_scan_finds_generic_brand_abbreviation_misspelling_…`.
- Y9 the R1-5 item always claims `/general_advice`: KILLED by `test_f5_no_g1_pointer_clash_on_200_generated_consults`.
- Y10 pipeline keeps a note naming an unposted drug: **SURVIVED** (461 passed).
- Y11 PCM abbreviation dropped: KILLED by `test_d3_moved_drug_never_visible_in_600_runs`.
- Y12 R1-5 run before the allowlist (F4 order): KILLED by `test_f4_withheld_advice_does_not_hide_the_red_flag`.

Required to pass:
- G1 and G2 to 0 on `h6_heldout.py` and `h8_plainmoved.py`;
- tests that kill Y6 and Y10;
- G3 and G4 ruled by fable (PASS-WITH-FIXES is possible once G1, G2 and G5 are done).
Re-run h1-h9 as the oracle.
