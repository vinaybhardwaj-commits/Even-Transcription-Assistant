# ETA → FreeScript artifact, v1.0: README for Pulse

ETA records the OPD room, transcribes it and turns each consult into one JSON artifact. This bundle defines version `eta.freescript.v1.0` of that artifact, with a schema, a validator, seven invented examples and a test set. It replaces `eta.freescript.v0.1` (29 Sep). Everything in this bundle is synthetic: no real patient, doctor, room or id appears anywhere.

Every claim below is either checked by `validate_artifact.py` (the rule is named) or marked **generator guarantee (not checked by validator)**. A generator guarantee is tested in ETA's generator, not by this bundle.

## What Pulse needs to read

Pulse needs only three parts of the artifact:

- the header (`schema_version`, `artifact_id`, `supersedes`, `created_at`, `emission`, `encounter`, `pulse_link`);
- `gp_extraction`, which has the exact shape of `pulsepb.GPLlmExtraction` (schema), so it can go to `hospitalGPMapper.Build` in place of the extraction LLM's output;
- `note_text`, the same content as an English note under the 11 FreeScript headings, for the text path.

Pulse drops unknown keys, so the rest of the artifact can be ignored safely. The rest is ETA's audit and review layer.

## What changed since v0.1, and why

1. **No medicine is posted.** In v0.1 a medicine in `gp_extraction` was a draft order. In v1.0 the default policy (`notes_only`) leaves `gp_extraction.medicines` empty, and no medicine name may appear in any `gp_extraction` string (V7). Each medicine the doctor decided on, including drugs stopped, held or refused, becomes a structured prompt for the doctor to confirm (V7). A drug the patient only mentioned stays in provenance, with no prompt and no Medication line (V7). This is why the version is a MAJOR bump.
2. **Every posted item cites the speech it came from.** A span registry holds quotes with times and speaker labels, and every posted item cites span ids (V4, V8, V12). That the quotes are verbatim STT or translation is a generator guarantee (not checked by validator).
3. **Rooms can hold more than two voices.** A roster records each voice and its role (treating doctor, other clinician, patient, attender, staff, translator, unknown). Only the treating doctor's voice can support an order, and only one voice may order (V8, V13). A translator repeating the doctor can support an item but never create one (V8). Which role each voice really has is a generator guarantee (not checked by validator); the validator checks that the roster obeys the fixed rules.
4. **Each drug attribute stands on its own.** Strength, dose, route, frequency, duration and instruction each cite their own speech and carry their own support state. A value counts as supported only when the treating doctor says it in a span that names the drug, or in the same turn. A patient saying "twice a day", or a doctor's bare "okay" after the patient said it, never supports a value (V8).
5. **The doctor's own words are kept.** Each instruction records whether it was firm or hedged, the doctor's final position when they changed their mind, how often they stressed it, and whether it was counselling. Each instruction, and each advice item, is a contiguous copy of one quote of the doctor's speech, and keeps every negation of that quote (V17). Advice is built only from final instructions (V10). That a hedged instruction is never presented as firm is a generator guarantee (not checked by validator).
6. **Red flags always carry.** An emergency or return-now condition the doctor says aloud is placed first in General Advice and is never cut by the advice length limit (V10). Its text is whole sentences of the doctor's quote, with the action clause intact (V17). Every instruction marked as a warning or red flag must have a red flag entry (V10).
7. **Each prompt names the drug carefully.** It gives the drug as spoken, the brand recognised, the GENERIC in capitals (IMC Regulations 2002 cl. 1.5), combination components, the base molecule with salt words removed, any look-alike/sound-alike risk, and the strength and form as heard (schema, V14).
8. **Placeholders never post.** Placeholders, data-structure text, brackets and "not stated"-only values are rejected in every posted string and in `note_text` (V11). Recording each withheld field in provenance is a generator guarantee (not checked by validator).
9. **Stopped and refused orders are never named.** v0.1 allowed "Stop X" under Plan, which a text parser can re-extract as an order. In v1.0 a stopped, held or refused order is never named in `note_text` or in any `gp_extraction` string (V9). It lives only in the confirm prompts and in provenance.
10. **Every consult in scope gets a record.** `emission` is `full`, or `withheld` with a reason code (V15). That ETA emits a record for every consult in scope is a generator guarantee (not checked by validator).
11. **Quality checks travel with the artifact.** The `qa` block carries the safety floors and the served model ids. The validator re-checks the counts and the red-flag floor itself (V2, V10) and requires the other floors to read 0. That the other floor values were measured is a generator guarantee (not checked by validator).
12. **Duration units match Pulse.** DurationUnit is DAYS, WEEKS, MONTHS, YEARS or HOURS. YEARS is sent directly, no longer as months × 12 (schema).

## The fields

| Field | What it holds |
|---|---|
| `schema_version` | Always `eta.freescript.v1.0`. |
| `artifact_id`, `supersedes`, `created_at` | This artifact's id, the id it replaces (or null), and when it was written. |
| `emission` | `state` is `full` or `withheld`. A withheld artifact gives reason codes: `no_bundle`, `no_role_track`, `no_stt`, `never_queued`, `no_order_capable_span`, `validator_fail`. |
| `policy` | `medicine_policy` (`notes_only`, the default; `taped_draft` is reserved), the advice budget (5 items / 300 characters) and the inputs mode. |
| `generator` | Code and prompt hashes, the models used (each with a served model id), temperature and run id. That every model call is zero-data-retention is a generator guarantee (not checked by validator). |
| `encounter` | ETA's encounter id, room, IST visit date, consult window, languages and transcript facts. |
| `pulse_link` | The ids Pulse needs to bind the artifact, each null when ETA does not know it. Unchanged from v0.1. That ETA never guesses an id is a generator guarantee (not checked by validator). |
| `roster` | One entry per voice: role, the votes of three independent role voters, whether all three said treating doctor, the voiceprint check, translator link and whether the voice may order. |
| `spans` | The cited speech: segment refs, times, speaker label, native and English quotes, and whether the span may support an order. |
| `gp_extraction` | `pulsepb.GPLlmExtraction`, field for field. ETA never adds keys (schema). Only supported items appear (V8). |
| `confirm_prompts` | One per medicine the doctor decided on, and one per order that cannot be supported. Each has an action (start, continue, stop, hold, change_dose, not_given), the drug-naming block, per-attribute support, who said it and why the doctor must confirm. |
| `doctor_words` | The doctor's instructions with firmness, final position, emphasis and counselling flags. |
| `red_flags` | Conditions the doctor stated that must always be shown. |
| `provenance` | One record for every posted item and prompt (V2), and for kept-out items and withheld fields, with status, support, cited spans and pointer into `gp_extraction`. |
| `note_text` | The 11 headings. The validator renders the note from `gp_extraction` and `confirm_prompts` and requires `note_text` to match that rendering line for line (V5, V6). Absent when withheld (V15). |
| `qa` | Safety floors, counts, the inputs used, the served model ids and the neutral render template id. |

The Medication section of `note_text` names the GENERIC first, in capitals, with the brand the doctor said in brackets after it (IMC 2002 cl. 1.5). A combination reads `GENERIC1 + GENERIC2 (Brand)`. A generic said alone shows no brand. A generic shown with a brand always comes from that brand's attested row in the curated brand map, never from inference. A brand with no attested row is never shown as if it were the drug: its line reads `<brand as spoken> — confirm generic`, and it always carries a look-alike risk flag (V6, V14). It looks like this:

```
Medication: Draft list, not a prescription; the treating doctor checks each drug.
AMOXICILLIN + CLAVULANIC ACID (Augmentin 625 Duo) — confirm
METFORMIN 1000 — dose change discussed — confirm
PREDNISOLONE — confirm
Pan-D — confirm generic
```

A strength appears on a line only when the treating doctor stated it for that drug (V6, V8). A change_dose line shows only the new dose the doctor stated, never the old strength; without one it shows no number (V6).

## Guarantees checked by the validator

`validate_artifact.py` checks each artifact against the schema and these eighteen rules. Name matching folds case, accents, invisible characters, lookalike Cyrillic and Greek letters, hyphens, dots and spaced-out letters before comparing.

| Rule | Guarantee |
|---|---|
| V1 | Every pointer from provenance into `gp_extraction` resolves, and each is claimed once. |
| V2 | Every posted entry and prompt has exactly one provenance record of the right kind, ids are unique, and the `qa` counts match. |
| V3 | A stopped, held or not-given order never appears in a `gp_extraction` list under any name ETA holds for it. |
| V4 | Every posted item cites speech, or carries the `no_evidence` flag. |
| V5 | `note_text` has the 11 FreeScript headings, once each, in order. |
| V6 | `note_text` equals the rendering of `gp_extraction` and `confirm_prompts`, section by section and line by line. Medication holds only the draft line and one confirm line per start, continue or change_dose prompt, each naming the GENERIC first with the brand in brackets, or ending `— confirm generic` when the generic is unresolved. |
| V7 | Catches: a non-empty `gp_extraction.medicines` under `notes_only`; any `gp_extraction` string naming a medicine from the curated lists (generics, brand map, salt drugs, look-alike names) or from the artifact's own prompts and provenance, unless, inside a diagnosis or comorbidity, a condition word sits right next to that drug name ("insulin resistance", "metformin-induced"); a decided medicine with no prompt; a patient-only drug with a prompt. Does not catch: a medicine name that is in no curated list and not in the artifact itself, when it carries no dose and follows no order verb (see V18 for those). |
| V8 | A posted order cites a span of the order-capable treating doctor that names it. A supported drug attribute is said by the order-capable treating doctor, in a span that names the drug or in the same turn. A patient-affirmed prompt, or a prompt from any other voice, never has a supported value. Advice and red flags are copied from the doctor's speech. For change_dose, the shown dose must be the new dose the doctor stated ("from X to Y", "X to Y", "increase/reduce to Y", "make it Y"); the old dose, or a dose the quote does not state as the new one, fails, and the line then carries no number. |
| V9 | Catches: a stopped, held or not-given order named in `note_text` or in any `gp_extraction` string, under its generic, brand, any brand of the same molecule, any combination component or `+` part, a split, dotted, hyphenated or spaced-out spelling, lookalike or accented letters, a close misspelling (similarity 0.85 or more for names of 6+ letters, one edit for names of 4-5 letters, never a common English word); and a missing `Medication changes discussed` line in Plan. Does not catch: an abbreviation or nickname that ETA does not hold for the drug (for example a shortened brand), or a misspelling further than those limits. Names of 3 letters or fewer match only exactly. |
| V10 | Catches: General Advice that does not start with the red flags, in order; an instruction marked warning or red flag with no red flag entry (recomputed, not trusted from `qa`); a red flag with no doctor span; advice beyond the red flags that is not a final doctor instruction, or that exceeds 5 items or 300 characters (items split at `.`, `!`, `;` and line breaks). Does not catch: whether the order of advice items follows the doctor's emphasis, or a warning the generator never recorded as a doctor instruction. |
| V11 | No placeholder, bracket of any kind, data-structure text, "not stated"-only value (N/A, nil, unknown, pending and similar), "TBD", addressed-to-doctor phrase, invisible or control character, or line break in any posted string, drug field or `note_text`; no non-ASCII letter in any posted string, rendered drug field or `note_text`. |
| V12 | Every cited span exists, lies inside the consult window, and is not at a quarantined consult boundary. |
| V13 | The roster is consistent. At most one voice may order, and it must be the treating doctor, chosen by fixed rules. A voiceprint conflict means no voice may order. With the voiceprint gate off, the voiceprint never contributes. |
| V14 | Catches: a match decided on a salt or qualifier word alone ("acid reflux" never becomes folic acid; "potassium" alone never becomes potassium chloride); a generic shown with a brand that is not exactly the generic of that brand's attested row in the curated map (never inferred, guessed or carried over from another drug); a brand with no attested row that still carries a generic; a spoken brand hidden behind a generic; a brand shown that the doctor did not say; a combination expanded without an attested row; a look-alike/sound-alike name, by generic or brand, without the flag; a null generic without the look-alike flag and an `unmapped`/`unexpanded` reason. Does not catch: a wrong row in the curated map itself. |
| V15 | A withheld artifact has a reason code, an empty `gp_extraction` and no `note_text`. |
| V16 | Model ids are present and well-shaped (not empty, "default", "latest", "unknown" or similar), and `qa.models_served` matches `generator.models`. The validator checks the shape of model ids only. That they were read back from the calls is a generator guarantee (not checked by validator). |
| V17 | Catches: an instruction, advice item or red flag that is not a contiguous, word-aligned copy of one of its cited quotes (only case, spacing and a final full stop may differ); a copy that leaves out a negation of that quote (not, no, never, don't, avoid, stop, without ...); a copy that leaves out a negation ending the same speaker's previous segment when that segment ended within 2.0 seconds (speech-to-text often splits "don't" from the rest); a red flag that is not whole sentences of its quote or has no action word (go, come, call, return ...). Does not catch: a split negation more than 2.0 seconds back, or said by another voice such as a translator; a negation inside the previous segment that is not its last word; negation by words outside the list ("hold off"); a quote that was itself mis-transcribed. |
| V18 | Catches, in every `gp_extraction` string and every note line outside Medication: a dose pattern (a number, a number word such as "five hundred" or "two fifty", or a Hindi or Kannada number word such as ek or ondu, with a unit written short or spelled out: mg, milligram, mcg, microgram, g, gram, ml, millilitre, IU, unit, tablet, capsule, puff, drop, teaspoon, sachet, goli, maatre; but not a lab unit such as mg/dL); a frequency token such as OD, BD, TDS, QID, HS, SOS or PRN, with or without dots, or q8h; a regimen such as 1-0-1; "x N days"; "for N days" outside the illness-history fields; a dosage-form word; any word that is neither in the English and clinical vocabulary (`data/`) nor a listed prompt's own name, wherever it stands ("Thyronorm every morning", "took Pacimol", "the Azee course"), except a drug name qualified by an adjacent condition word inside a diagnosis or comorbidity; a Medication line with no drug name. Does not catch: a drug name that is also an ordinary English word in the vocabulary, or a generic missing from the denylist that a large English dictionary happens to hold; a word frequency such as "twice daily". Specialist clinical words missing from the vocabulary fail (a false fail), so the generator writes plain clinical English. |

## Limits

- An artifact proves what was said in the room, not what is clinically right. The doctor confirms every medicine.
- The brand-to-generic map, the medicine-name lists, the drug denylist, the salt drugs and the look-alike list in `data/` are curated lists. A generic name that is both absent from them and present in the large English dictionary can still pass (V7, V18); a brand with no attested row never shows a generic.
- Speaker roles come from automatic voting and voice matching. When they disagree, no voice may order and everything becomes a prompt. This is safe, but it adds work for the doctor.
- `taped_draft`, which would post well-supported medicines as draft lines, is reserved. The validator rejects any posted medicine until it is agreed.
- The examples are invented and short. They show the shape and the rules, not real performance.

## Versioning

v1.0 is a MAJOR version because a medicine no longer means a draft order. We propose running v0.1 and v1.0 in parallel for an agreed window, with `schema_version` telling them apart, and retiring v0.1 at the end of it. Later additive changes will be MINOR versions (v1.1, …): new optional fields that Pulse can ignore. Anything that changes the meaning of an existing field will be a new MAJOR version.

## Open questions for Pulse

These are unchanged since v0.1, and none has been put to Pulse yet.

- **Q1 Transport.** How should artifacts reach Pulse (push, pull or queue)?
- **Q2 Binding.** Which ids must be present to bind an artifact to one prescription?
- **Q3 Draft or submitted.** Today `Build` overwrites the doctor's text. Should ETA's content land as a draft the doctor edits, or never touch a submitted prescription?
- **Q4 Entry point.** We recommend the structured path (`gp_extraction` into `hospitalGPMapper.Build`) over the text path.
- **Q5 Review UI.** How should Pulse show `confirm_prompts` to the doctor?
- **Q6 Auth and idempotency.** How are calls authenticated, and is `artifact_id` with `supersedes` enough to make re-sends safe?
- **Q7 Retention.** How long may Pulse keep the artifact, and which parts?
- **Q8 Gating.** Which doctors and rooms are switched on, and who holds that list?
- **Q10 Combination brands (new).** Will Pulse accept one note line for a combination brand with several components, such as `AMOXICILLIN + CLAVULANIC ACID (Augmentin 625 Duo) — confirm`?

Generic versus brand order is settled: ETA's clinical owner ruled generic first, with the brand as spoken in brackets (IMC 2002 cl. 1.5). The validator enforces it (V6, V14).

## Integration sketch

1. Read `schema_version`. Route `eta.freescript.v0.1` to the current path and `eta.freescript.v1.0` to the new one.
2. Run `validate_artifact.py` (or an equivalent port) and ingest nothing that fails.
3. If `emission.state` is `withheld`, ingest nothing. Log the reason codes.
4. Bind with `pulse_link`. If the ids are not enough to bind with confidence, ingest nothing (Q2).
5. Pass `gp_extraction` to `hospitalGPMapper.Build`. Its `medicines` list is empty under `notes_only`.
6. Show `confirm_prompts` to the doctor as a checklist (Q5). A confirmed medicine becomes a prescription line only through the doctor's action.
7. Use `note_text` only for the text path. Never parse orders out of it.
8. Treat a later artifact whose `supersedes` names an earlier `artifact_id` as a replacement, not an addition (Q6).

## Files

| File | Purpose |
|---|---|
| `eta-freescript-artifact.v1.0.schema.json` | JSON Schema (draft-07). |
| `validate_artifact.py` | Schema plus V1–V16, and the note renderer. `python3 validate_artifact.py FILE...`; exits 1 on any failure and prints one line per failure naming its rule (V0 is the schema). Needs `jsonschema`. |
| `data/*.json`, `data/SCOWL-LICENSE.txt` | The curated look-alike pairs, salt and qualifier words, salt drugs, medicine names, drug denylist, brand-to-generic map, FRX-N1 phrases, dose patterns, copy rules, and the vocabulary (a common-English list, clinical words, and a SCOWL dictionary list with its licence). |
| `examples/ex1`–`ex7` and `build_examples.py` | Seven invented valid artifacts and their deterministic builder. |
| `tests/mutants/`, `tests/expected.tsv`, `tests/build_mutants.py`, `tests/run_mutants.py` | One-change artifacts with their expected verdicts: at least two per rule, plus an adversarial set for each fix item. |
| `tests/vocab/` | The vocabulary tests: clinical-word coverage, and zero false fails on the 7 examples and 20 invented clean notes. |
| `run_checks.sh` | Runs all checks; exits 0 only when every example is valid, every mutant matches and both builders reproduce their output byte for byte. |
| `CHANGELOG-v0.1-to-v1.0.md` | Field-by-field diff. |
| `HANDOFF-INDEX.md` | sha256 of every file, and the privacy sweep. |
