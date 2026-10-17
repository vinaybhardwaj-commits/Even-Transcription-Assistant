# FRX-V1-FIX1-REPORT (cloud-frx-v1-handoff, fix round 1, 17 Oct 2026)

Serving model: `claude-opus-5-5` (get_session: session_context.model and last_served_model).
Branch `cloudpane/cloud-frx-v1-handoff/v2` (v1 left as is; no main, no PR). Fix commit `5ddfd33d`; this report is the next commit.

## Checks
- `handoff/eta-freescript-v1.0/run_checks.sh` exits 0. Examples are 7/7 valid. Mutants: 128/128 rows match `tests/expected.tsv` (109 fail rows naming their rule, 19 pass controls). Both builders are byte-identical on rebuild.
- Adversarial suite: 65 of the 128 rows are new M/S rows (M1:9 M2:9 M3:4 M4:3 M5:5 M6:4 M7:1 M8:3 M9:11 S1:5 S2:1 S3:1 S4:2 S5:3 S6:4). The 63 v1 rows were kept, with 3 retargeted after the ex1/ex3 changes, plus a V12 who_said row.
- Each new fail row was spot-read: it fails on its intended rule, not by accident. A further scratch probe (leetspeak, digit-in-name, Devanagari, CRLF, tab, curly quotes, Cyrillic heading, superseded advice) caught everything except tab characters. That gap is fixed and the probes were added as mutants.
- `handoff/eta-internal/run_internal_checks.sh` exits 0. It runs the Pulse checks, the privacy sweep (12 patterns, 0 unexplained hits), the README/placement checks (0 failures), and 5 planted S7/S8 violations, all caught.
- `HANDOFF-INDEX.md`: 150 files hashed, re-verified 150/150. S11/S12 are described, not listed, so the index names nothing internal.

## Closure
| Item | Status | Where / test |
|---|---|---|
| M1 held + medicine names in every gp string; note line-for-line | closed | V9 on every gp string; V7 medicine-name check (condition-word exception in dx/comorbidity only); V6 note == render_note. M1_* (9) |
| M2 NFKD, accents, casefold, separators, homoglyphs; non-ASCII letters rejected | closed | `fold()`/`toks()` in every match; V11 non_ascii/invisible. M2_* (9) |
| M3 combination components in held names | closed | `held_names`: brand-map components, '+' parts, and brands containing a held molecule. M3_* (4) |
| M4 warning / red_flag word needs a red_flags entry; floor recomputed | closed | V10; `red_flag` field added to doctor_words. M4_* (3) |
| M5 no supported value from a non-capable who_said, affirmed prompt, or a span not naming the drug | closed | V8 `cap_td` + `names_in_turn`. M5_* (5) |
| M6 FRX-N1 in Medication lines and drug fields | closed | V11 on every drug field and Medication line; d4 ported in full. M6_* (4) |
| M7 discussed_only is not a prompt | closed | V7; ex1 fixed. M7_* (1) |
| M8 change_dose listed | closed | LISTED_ACTIONS, `med_line`; ex3 metformin. M8_* (3) |
| M9 NFKC first; wider bracket class; whole-value missing words | closed | `printable()`; data filler regex. M9_* (11) |
| S1 fuzzy ≥0.85 + spaced letters; brand map expanded | closed | V9 fuzzy on held drugs; 20 brand entries with attested flags. S1_* (5) |
| S2 posted order named in a cited span | closed | V8. S2_* (1) |
| S3 advice split on ';' and line breaks | closed | `split_items`; line breaks also rejected (V11). S3_* (1) |
| S4 LASA by brand or generic; no null generic for a LASA brand | closed | V14. S4_* (2) |
| S5 placeholder model ids; README says shape only | closed | V16 shape regex + deny list; README V16 row. S5_* (3) |
| S6 salt drugs keep full phrase | closed | `data/salt_drugs.json`, `base_of`. S6_* (4) |
| S7 README claims enforced or marked | closed | README rewritten; `check_pulse_docs.py` + 2 planted negatives |
| S8 rationale moved; no internal names | closed | `handoff/eta-internal/`; `privacy_sweep.py` + 3 planted negatives |

## Rulings applied and new ASSUMPTIONs (full text in handoff/eta-internal/DESIGN-RATIONALE.md)
- A5: V8 accepts orders only on the treating doctor's order-capable spans, and V13 lets only a treating_doctor label be order-capable. A7: discussed_only has no prompt. A9: change_dose is listed. A11: narrowed. A17: data file says 8 unordered = 16 ordered pairs.
- A24 A Medication line shows a strength only when it is supported; for change_dose it shows the dose, else the strength.
- A25 The medicine-name list is GENERICS + brand map + salt drugs + LASA names + the artifact's own names; condition words exempt only dx/comorbidity strings.
- A26 Curly quotes count as brackets; non-ASCII letters, control and invisible characters and line breaks are rejected in posted strings.
- A27 note_text must equal `render_note(artifact)` exactly.
- A28 Advice items must be final doctor_words; doctor_words and red flags are copied from their quotes.
- A29 Fuzzy matching applies to held medicines only, on keys of 6+ letters.
- A30 who_said must match the roster.

## Key sha256 (all files in HANDOFF-INDEX.md)
- `08d463919c85ed097e8f5e87b48dd79758871e8c29fb545a866057a573198ca8` validate_artifact.py
- `19393362a365fb600563ff81edce52a3b7ce057876cb233a95fde0b45a06ed92` schema
- `d6b9fc1d088bc4dfec04adc4809c07a9bf98c9e79584545a1f295fb8fe2cbb40` README-FOR-PULSE.md
- `2d9cea6c2eeaad15455d4e835010ecc8d21d62ad2e78e6d79fc75d1b0587b394` HANDOFF-INDEX.md
- `63e68e28d24de14e0773d8c8b896e2a3c86fe6d510fe3f953e0b18acaa11e5c9` tests/expected.tsv

## Limits
- A medicine brand that is in neither the curated lists nor the artifact's own names can still appear in a gp string undetected (README Limits says so).
- The hold-out set was not available here; the closure above rests on the suite written in this round.
