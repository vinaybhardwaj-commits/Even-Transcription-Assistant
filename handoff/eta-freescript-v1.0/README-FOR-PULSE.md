# ETA → FreeScript artifact, v1.0: README for Pulse

ETA records the OPD room, transcribes it and turns each consult into one JSON artifact. This bundle defines version `eta.freescript.v1.0` of that artifact, with a schema, a validator, seven invented examples and a test set. It replaces `eta.freescript.v0.1` (29 Sep). Everything in this bundle is synthetic: no real patient, doctor, room or id appears anywhere.

## What Pulse needs to read

Pulse needs only three parts of the artifact:

- the header (`schema_version`, `artifact_id`, `supersedes`, `created_at`, `emission`, `encounter`, `pulse_link`);
- `gp_extraction`, which has the exact shape of `pulsepb.GPLlmExtraction`, so it can go to `hospitalGPMapper.Build` in place of the extraction LLM's output;
- `note_text`, the same content as an English note under the 11 FreeScript headings, for the text path.

Pulse drops unknown keys, so the rest of the artifact can be ignored safely. The rest is ETA's audit and review layer.

## What changed since v0.1, and why

1. **No medicine is posted.** In v0.1 a medicine in `gp_extraction` was a draft order. In v1.0 the default policy (`notes_only`) leaves `gp_extraction.medicines` empty. Every medicine the consult mentions, including drugs that were stopped or refused, becomes a structured prompt for the doctor to confirm. Room audio cannot always support a medicine order, and a prompt says so honestly. This is why the version is a MAJOR bump.
2. **Every item cites the speech it came from.** A span registry holds verbatim quotes with times and speaker labels, and every item cites span ids. v0.1 had only free-text evidence quotes.
3. **Rooms can hold more than two voices.** A roster records each voice and its role (treating doctor, other clinician, patient, attender, staff, translator, unknown). Only the treating doctor's voice can support an order. A translator repeating the doctor can support an item but never create one.
4. **Each drug attribute stands on its own.** Strength, dose, route, frequency, duration and instruction each cite their own speech and carry their own support state. A patient saying "twice a day" never supports a frequency.
5. **The doctor's own words are kept.** Each instruction records whether it was firm or hedged, the doctor's final position when they changed their mind, how often they stressed it, and whether it was counselling. Advice is built from these.
6. **Red flags always carry.** An emergency or return-now condition the doctor says aloud is placed first in General Advice and is never cut by the advice length limit.
7. **Each prompt names the drug carefully.** It gives the drug as spoken, the brand recognised, the GENERIC in capitals (IMC Regulations 2002 cl. 1.5), combination components, the base molecule with salt words removed, any look-alike/sound-alike risk, and the strength and form as heard.
8. **Withholding is explicit.** Placeholders, data-structure text and "not stated"-only values are withheld and recorded, never posted.
9. **Stopped and refused drugs never appear in `note_text`.** v0.1 allowed "Stop X" under Plan, which a text parser can read back as an order. In v1.0 they live only in the confirm prompts and in provenance.
10. **Every consult in scope gets a record.** `emission` is `full`, or `withheld` with a reason code, so a missing note always has a stated cause.
11. **Quality checks travel with the artifact.** The `qa` block carries the safety floors and the model ids actually served.
12. **Duration units match Pulse.** DurationUnit is DAYS, WEEKS, MONTHS, YEARS or HOURS. YEARS is sent directly, no longer as months × 12.

## The fields

| Field | What it holds |
|---|---|
| `schema_version` | Always `eta.freescript.v1.0`. |
| `artifact_id`, `supersedes`, `created_at` | This artifact's id, the id it replaces (or null), and when it was written. |
| `emission` | `state` is `full` or `withheld`. A withheld artifact gives reason codes: `no_bundle`, `no_role_track`, `no_stt`, `never_queued`, `no_order_capable_span`, `validator_fail`. |
| `policy` | `medicine_policy` (`notes_only`, the default; `taped_draft` is reserved), the advice budget (5 items / 300 characters) and the inputs mode. |
| `generator` | Code and prompt hashes, the models used (each with the served model id the provider returned), temperature and run id. Every model call is zero-data-retention. |
| `encounter` | ETA's encounter id, room, IST visit date, consult window, languages and transcript facts. |
| `pulse_link` | The ids Pulse needs to bind the artifact, each null when ETA does not know it. ETA never guesses an id. Unchanged from v0.1. |
| `roster` | One entry per voice: role, the three role votes (fields `role_track`, `clef`, `jev`), whether all three said treating doctor, the voiceprint check, translator link and whether the voice may order. |
| `spans` | The cited speech: segment refs, times, speaker label, native and English quotes (both verbatim), and whether the span may support an order. |
| `gp_extraction` | `pulsepb.GPLlmExtraction`, field for field. ETA never adds keys. Only supported items appear. |
| `confirm_prompts` | One per medicine, and one per order that cannot be supported. Each has an action (start, continue, stop, hold, change_dose, not_given), the drug-naming block, per-attribute support, who said it and why the doctor must confirm. |
| `doctor_words` | The doctor's instructions with firmness, final position, emphasis and counselling flags. |
| `red_flags` | Conditions the doctor stated that must always be shown. |
| `provenance` | One record for every posted item, prompt, kept-out item and withheld field, with its status, support, cited spans and pointer into `gp_extraction`. |
| `note_text` | The 11 headings, rendered only from the posted items, red flags and doctor's words. Absent when withheld. |
| `qa` | Safety floors, counts, the inputs used, the served model ids and the neutral render template id. |

The Medication section of `note_text` looks like this:

```
Medication: Draft list, not a prescription; the treating doctor checks each drug.
AMOXICILLIN + CLAVULANIC ACID (Augmentin 625 Duo) — confirm
PREDNISOLONE — confirm
```

## Guarantees

`validate_artifact.py` checks each artifact against the schema and these sixteen rules. ETA refuses to send an artifact that fails any of them.

| Rule | Guarantee |
|---|---|
| V1 | Every pointer from provenance into `gp_extraction` resolves, and each is claimed once. |
| V2 | Every posted entry, prompt and kept-out item has exactly one provenance record, and the `qa` counts match. |
| V3 | A stopped or not-given order never appears in a `gp_extraction` list under any name ETA holds for it. |
| V4 | Every posted item cites speech, or carries the `no_evidence` flag. |
| V5 | `note_text` has the 11 FreeScript headings, once each, in order. |
| V6 | Each order section of `note_text` has one line per posted entry. Medication holds only the draft line and one confirm line per start or continue prompt. |
| V7 | Under `notes_only`, `gp_extraction.medicines` is empty and every medicine has a confirm prompt. |
| V8 | A posted order and every supported drug attribute stand on speech from the voice allowed to order; a note item stands on a doctor's speech. A patient's words that the doctor only acknowledged never support a drug or dose. |
| V9 | No stopped, held or not-given order is named anywhere in `note_text`, under its generic, brand, alias, base molecule or a split spelling. |
| V10 | Red flags come first in General Advice and survive the length limit; the rest stays within 5 items and 300 characters. |
| V11 | No placeholder, bracket, data-structure text, "not stated"-only value, "TBD" or addressed-to-doctor phrase in any posted string or in `note_text`. |
| V12 | Every cited span exists, lies inside the consult window, and is not at a quarantined consult boundary. |
| V13 | The roster is consistent: at most one voice may order, chosen by fixed rules; a voiceprint conflict means no voice may order; with the voiceprint gate off, the voiceprint never contributes. |
| V14 | No drug name is matched on a salt or qualifier word alone ("acid reflux" never becomes folic acid), combinations expand only when the curated map attests them, and every look-alike/sound-alike drug is flagged. |
| V15 | A withheld artifact has a reason code, an empty `gp_extraction` and no `note_text`. |
| V16 | The served model ids are recorded, non-empty and read back from the calls. |

## Limits

- An artifact proves what was said in the room, not what is clinically right. The doctor confirms every medicine.
- The brand-to-generic map, the salt-word list and the look-alike list in `data/` are small curated lists. A brand that is not in the map stays unresolved; a combination brand that is not attested stays unexpanded.
- Speaker roles come from automatic voting and voice matching. When they disagree, no voice may order and everything becomes a prompt, which is safe but adds work for the doctor.
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

One question sits with ETA's clinical owner rather than Pulse: should the generic come first with the brand in brackets (IMC 2002), or the brand as spoken first? v1.0 defaults to generic first.

## Integration sketch

1. Read `schema_version`. Route `eta.freescript.v0.1` to the current path and `eta.freescript.v1.0` to the new one.
2. If `emission.state` is `withheld`, ingest nothing. Log the reason codes.
3. Bind with `pulse_link`. If the ids are not enough to bind with confidence, ingest nothing (Q2).
4. Pass `gp_extraction` to `hospitalGPMapper.Build`. Its `medicines` list is empty under `notes_only`.
5. Show `confirm_prompts` to the doctor as a checklist (Q5). Each confirmed medicine becomes a prescription line only through the doctor's action.
6. Use `note_text` only for the text path. Never parse orders out of it.
7. Treat a later artifact whose `supersedes` names an earlier `artifact_id` as a replacement, not an addition (Q6).

## Files

| File | Purpose |
|---|---|
| `eta-freescript-artifact.v1.0.schema.json` | JSON Schema (draft-07). |
| `validate_artifact.py` | Schema plus V1–V16. `python3 validate_artifact.py FILE...`; exits 1 on any failure and prints one line per failure naming its rule (V0 is the schema). Needs `jsonschema`. |
| `data/*.json` | The curated look-alike pairs, salt and qualifier words, brand-to-generic map and FRX-N1 phrases. |
| `examples/ex1`–`ex7` and `build_examples.py` | Seven invented valid artifacts and their deterministic builder. |
| `tests/mutants/`, `tests/expected.tsv`, `tests/build_mutants.py`, `tests/run_mutants.py` | 62 one-change artifacts, at least two per rule, with their expected verdicts. |
| `run_checks.sh` | Runs all checks; exits 0 only when every example is valid, every mutant matches and both builders reproduce their output byte for byte. |
| `CHANGELOG-v0.1-to-v1.0.md` | Field-by-field diff. |
| `HANDOFF-INDEX.md` | sha256 of every file, and the privacy sweep. |
