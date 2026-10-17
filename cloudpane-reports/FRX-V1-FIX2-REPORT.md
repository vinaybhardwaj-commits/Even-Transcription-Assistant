# FRX-V1-FIX2-REPORT (cloud-frx-v1-handoff, fix round 2, 17 Oct 2026)

Serving model: `claude-opus-5-5`.
Branch `cloudpane/cloud-frx-v1-handoff/v3`, built from v2 (v1 and v2 left as they are; no main, no PR). Fix commit `8bd7f503`; R9 addendum in the next commit, with this report.

## Checks
- `handoff/eta-freescript-v1.0/run_checks.sh` exits 0. Examples are 7/7 valid. Mutants: 159/159 rows match `tests/expected.tsv`. Both builders are byte-identical on rebuild. There is no `__pycache__` before or after the run.
- New R mutants: R1 6 (2 controls), R2 11 (3), R3 4 (1), R4 3 (1), R5 4 (2), R6 3 (1). Each failing R row was read: it fails on its intended rule, and every control passes.
- `handoff/eta-internal/run_internal_checks.sh` exits 0. The privacy sweep finds 0 unexplained hits, the README checks (now V1–V18) find 0 failures, and all 6 planted violations are caught, including a planted `__pycache__`.
- `HANDOFF-INDEX.md`: 184 files hashed, re-verified 184/184.

## What changed, per R-number
- **R1 (new V17).** Doctor_words text, every advice item and red-flag text must be a contiguous, word-aligned substring of one cited quote. Only case, spacing, straight-versus-curly apostrophes and one final `.`/`!` may differ. No negator of that quote may fall outside the copied part. A red flag must be whole sentences of its quote and contain an action word. The v2 word-subset checks were removed. Tests cover reordered words, a dropped "don't", a red flag cut before its action clause, and a reworded red flag; the controls are a contiguous part and a case-only change.
- **R2 (new V18 dose guard; V7 tightened).** Dose patterns are checked in every gp string outside `/medicines` and every note line outside Medication. The patterns are a number or number word with mg/mcg/g/ml/IU/units/tab/cap/puff/drop/sachet (lab units like mg/dL excluded); OD/BD/TDS/QID/HS/SOS/PRN, also with dots, and q8h; 1-0-1; x N days; and "for N days" outside history fields. Any hit fails. The condition-word exemption now needs the condition word directly next to each occurrence of the drug name ("insulin resistance on metformin" fails).
- **R3 (V18).** Dosage-form words anywhere fail. In Plan, Advice and Follow up, a word after an order verb (start, take, continue, increase, stop …) must be English or clinical vocabulary (`data/english_words_min.json`), so "Start Zorvix" fails. A Medication line must start with a drug name. Under notes_only, every listed medicine name was already rejected in gp strings (V7).
- **R4 (V6 render).** change_dose shows only the dose attribute when supported. It never falls back to the strength or `strength_heard`; otherwise there is no number. ex3 now carries the new dose in `dose`.
- **R5 (V9).** Keys of 6+ letters keep ratio ≥ 0.85; keys of 4-5 letters add edit distance 1. Common English words are never treated as misspellings ("band" and "solo" pass).
- **R6 (V14).** A null generic must carry `lasa_risk.pair_with` and the `lasa` reason. LASA-listed brands and generics were already flagged (S4).
- **R7.** README rows V7, V9 and V10 now say "Catches … Does not catch …". V17 and V18 rows were added in the same form, and the count reads eighteen rules.
- **R8.** run_checks.sh fails if any `__pycache__` exists, before or after the checks; none is in the bundle.
- **A26.** The example generator folds curly quotes and accents to ASCII (`ascii_fold`) before validation.

## R9 addendum (generic first, final ruling)
- Renderer: `GENERIC (Brand as spoken)`, `GENERIC1 + GENERIC2 (Brand)`, generic alone with no brand, and `<brand as spoken> — confirm generic` for a null generic (lasa_risk still required by R6).
- V6 checks that each Medication line names the GENERIC first and that an unresolved generic ends in `— confirm generic`. V14 rejects a brand in the generic field and a brand the doctor did not say. The schema descriptions and README state the rule; the README open question is replaced by the ruling.
- Mutants: brand-first line (V6), brand in the generic field (V14), brand shown but not spoken (V14) and unmapped brand shown as the drug (V6) all fail; the generic-only control passes. Totals after R9: 164/164 rows match, `run_checks.sh` and the internal checks exit 0, and the index lists 189 files.
- A40 "brand said" means the brand key, or its brand-map key, is in the spoken form. A41 The `— confirm generic` tail is exempt from FRX-N1 d2 like `— confirm`.

## New ASSUMPTIONs (full text in handoff/eta-internal/DESIGN-RATIONALE.md)
- A31 One added final `.` or `!` is allowed; when an item cites several quotes, one quote that fully contains it with no negator left outside is enough.
- A32 The negator and action-word lists are in `data/copy_rules.json`; sentence boundaries are `.` `;` `!` `?`.
- A33 "for N days" is illness history (allowed) in symptoms, diagnoses, comorbidities and examination; slash lab units and ISO dates are not doses.
- A34 Under notes_only, "a dose next to an unlisted word" reduces to "any dose pattern in any gp string".
- A35 Medicine-like mentions use dosage-form words and order verb + unknown word, against an 8.7k-word vendored English and clinical list ("acid", "vitamin" and one sweep-colliding word removed).
- A36 The change_dose new dose lives in `dose`; R4's "dose — confirm" is read as the approved tail `— dose change discussed — confirm` with no number.
- A37 Common English words are never fuzzy matches, at any key length.
- A38 A null generic carries `pair_with` such as "unresolved generic".
- A39 "Next to" means the word directly before or after the drug name, or "allergy/allergic to/of" before it; every occurrence must be qualified.

## Residual limits
- An unknown drug name with no dose, no dosage form and no preceding order verb passes ("Zorvix helped").
- A word frequency ("twice daily") is not a dose pattern, because lifestyle advice uses it.
- A drug name that is also an ordinary English word passes the order-verb check.
- V17 cannot detect a quote that was itself mis-transcribed. Negation by words outside the list ("hold off") is not tracked.
- Held-name matching stops at one edit for 4-5 letter keys and ratio 0.85 for longer keys; abbreviations ETA does not hold are not caught.
- The refuter's 54 hold-out attacks were not available here; closure rests on this round's suite.
