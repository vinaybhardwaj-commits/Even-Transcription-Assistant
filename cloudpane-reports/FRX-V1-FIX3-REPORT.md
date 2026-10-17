# FRX-V1-FIX3-REPORT (cloud-frx-v1-handoff, fix round 3, 17 Oct 2026)

Serving model: `claude-opus-5-5`.
Branch `cloudpane/cloud-frx-v1-handoff/v4`, built from v3 `5e7fea28` (v1–v3 left as they are; no main, no PR). Fix commit `7a1fd23f`; this report is the next commit.

## Checks
- `run_checks.sh` exits 0. Examples are 7/7 valid. Mutants: 188/188 rows match (now checked in-process; the CLI exit code is smoke-tested). Both builders are byte-identical on rebuild. There is no `__pycache__`. Step 5 is the new vocabulary test: coverage 129/129 clinical words, false fails 0/7 examples and 0/20 clean notes.
- `eta-internal/run_internal_checks.sh` exits 0. The sweep finds 0 unexplained hits, the doc checks 0 failures, and all 6 planted violations are caught. `HANDOFF-INDEX.md` hashes 221 files.
- New mutants: R10 4 (1 control), R11 4 (2), R12 5 (1), R13 6 (1), R14 5 (2). Each failing row was read: it fails on its intended rule.

## R10 attested-only generics (V14)
A brand's generic must equal the generic of that brand's own attested brand-map row (and its components). A brand with no attested row (unmapped, or guard-only such as Calpol or PCM) must have a null generic, the line `<brand as spoken> — confirm generic`, lasa_risk, and the new reason `brand_unmapped` (or `combination_unexpanded`). A spoken brand may not hide behind a generic. A40 is narrowed to this. Tests: Calpol→PARACETAMOL, Zorvix→PARACETAMOL and Dolo 650→IBUPROFEN fail; Zorvix with a null generic passes.

## R11 split negators (V17)
If the same speaker's previous segment ends within 2.0 s on a negator ("don't", "do not", "not", "never", "no", "avoid", "stop"…), that negator is joined in front of the cited quote. A copy that omits it fails; one that starts with it passes. The README V17 row lists what this does not catch: splits over 2.0 s, a negator said by another voice, a negator that is not the last word, negation outside the list, and mis-transcribed quotes. Tests: a dropped split "do not" in advice and in a red flag fails; "Do not skip meals." passes, and so does a gap of 3 s (a stated limit).

## R12 spelled units and number words (V18)
Units now include milligram, microgram, millilitre/milliliter, gram, unit, tablet, capsule, puff, drop, teaspoon, tablespoon, sachet, goli and maatre. Number words cover 0–20, the tens, hundred, thousand, half, quarter and their combinations ("five hundred", "two fifty" = 250), plus Hindi (ek, do, teen, paanch, aath…) and Kannada (ondu, eradu, mooru, aidu, entu…), a superset of the P-SYN set. Tests: "five hundred milligrams", "two fifty mg", "ek goli" and "ondu maatre" fail; counts without units pass.

## R13 vocabulary rule (V18, structural)
Under notes_only, every word of 3+ letters in every gp string must be in the vocabulary or be a listed prompt's own name. A drug word with an adjacent condition word inside a diagnosis or comorbidity is still allowed. V7 still bans listed drug names in gp strings. The vocabulary is the common-English list, the repo clinical terms, a curated clinical supplement, and SCOWL size-70 American and British lowercase words (Debian `wamerican-huge`/`wbritish-huge`, licence in `data/SCOWL-LICENSE.txt`). A new `data/drug_denylist.json` (~330 generics plus stems) is removed from the vocabulary and also feeds V7. Tests: "Thyronorm every morning", "Ecosprin aspirin as before", "took Pacimol", "the Azee course" and the unlisted stopped brand "Glimisave" fail; an ordinary plan passes.
**False fails:**

| Set | Result | Note |
|---|---|---|
| 7 examples | 0/7 | in-sample |
| 20 clean notes | 0/20 | in-sample; before tuning 17/20 |
| Held-out batch 1 | 3/10 | written after tuning; it then informed the move to SCOWL size 70 |
| Held-out batch 2 | 2/10 (ENT, sialadenitis) | untouched, out-of-sample |

## R14 change_dose new dose (V8)
The shown dose must be the Y of "from X to Y", "X to Y", "increase/reduce … to Y" or "make it Y" in the doctor's cited span. Equal to X fails, not equal to Y fails, and no pattern means it cannot be supported (the line shows no number). Tests: the old dose from "from 500 to 1000", an undecidable quote, and a "make it 750" mismatch fail; "from 1000 to 500" and "make it five hundred" pass.

## New ASSUMPTIONs (full text in eta-internal/DESIGN-RATIONALE.md)
- A42 The brand row is matched by brand key, with strength, form and pack words stripped.
- A43 New reason `brand_unmapped`.
- A44 A spoken mapped brand must be recorded as `brand_recognised`.
- A45 R11 "previous segment" is the same label's latest earlier span; gap is t0 minus previous t1; the negator is the last word or "do not".
- A46 Number-word and unit sets; "a"/"an" may sit between number and unit.
- A47 Vocabulary composition; 1-2 letter words are not checked; salt words count as vocabulary.
- A48 R14 patterns are read only on the order-capable doctor spans cited by the dose.
- A49 The third-party licence file is not swept, and the dictionary lists are exempt from the model/internal-name sweeps.

## Residual limits
- Specialist clinical words outside the vocabulary false-fail R13: about 20% of held-out notes that use them.
- A generic missing from the denylist but present in the SCOWL dictionary passes R13 (the probe found and denylisted 13 such names).
- A drug name that is also an ordinary English word passes R13.
- Split negators beyond 2.0 s, or from another voice, are not caught.
- The bundle grew to 8.1 MB (the SCOWL list is 3.4 MB).
- The refuter's hold-out set was not available here.
