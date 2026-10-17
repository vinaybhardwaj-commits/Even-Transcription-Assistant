# eta.freescript.v1.0: design rationale (ETA-internal)

This file holds the settled design the bundle was built from, verbatim, followed by every ASSUMPTION the Builder made where the design was silent or ambiguous. It is ETA-internal and is not part of what Pulse needs to read; Pulse reads `README-FOR-PULSE.md`.

---

## THE DESIGN (settled, verbatim)

# ETA → FreeScript artifact `eta.freescript.v1.0`: design (newcat-orch, 17 Oct 2026)

This supersedes the 29 Sep handoff (`eta.freescript.v0.1`) and folds in everything since: the v0.2/v0.3 code schemas, the 16 Oct blind review, the notes-only restart (approved by V on 16 Oct), the FRX R1/R1b/R2 safety floors and refutes, the Encounter Brief (spec v3 plus rulings), the PDQI-9 scoring design (v7 plus Fable's S2c conditions) and the drug-naming work.

Status: a design for fable's review. FreeScript build and review are fable's lane. The bundle is synthetic only.

## 0. What changed since v0.1, and why (one line each)
1. **MAJOR bump.** Medicines changed meaning. In v0.1 a medicine in `gp_extraction` was a draft order. In v1.0 the default `medicine_policy=notes_only` puts NO medicine in `gp_extraction`; every medicine, including stops, becomes a structured doctor-confirm prompt. This is V's 16 Oct ruling. The review found 11% of doctors' medicines posted and 25 untaped-drug posts. A prompt is honest about what audio can support.
2. **Span registry plus cited spans.** Every item cites span ids. Every span carries who spoke it and whether that voice may order. PDQI-9 A4.1 alignment, `h_unattrib` and recall all need this, and v0.1 had only free-text evidence quotes.
3. **Fluid-room speaker model.** The model records a roster of N voices with roles (treating doctor, other clinician, patient, attender, staff, translator, unknown), the 3/3 role vote, arm (c) voiceprint identity, and the gate state. Only the order-capable span set can support an order item. A translator relay can support an item but never create one. This is V's fluid-room ruling and EB v3 §6.3.
4. **Per-attribute support.** Strength, dose, route, frequency, duration and instruction each cite their own span and support state (PDQI-9 A4.1a.8, Fable C2). A patient saying "twice a day" inside a merged label never supports a frequency.
5. **Doctor's-words layer.** Each instruction carries firmness (firm or hedged), final position (reversals resolved, the last word wins), emphasis count and counselling flags. This drives advice and plan rendering and counselling recall (thresholds 0.85 and 0.80). Counselling recall was 66% in the review.
6. **Must-carry red flags.** An emergency or return condition the doctor states on tape must appear in advice and is never trimmed by the advice budget. This is the review's one unsafe note.
7. **Drug-naming block** on every prompt: spoken form, recognised brand, GENERIC in capitals (IMC Regulations 2002 cl. 1.5), combination components, the base molecule with salt and qualifier words stripped, look-alike/sound-alike (LASA) risk, and strength and form as heard. This covers R2 D5 (acid/sodium), the 16 L2 LASA pairs, combination brands and the brand-first gate.
8. **Withholding is explicit.** `field_withheld` items for placeholders, reprs and whole-value missing statements. No dict reprs (13.3% of consults in the review), no brackets, no "TBD".
9. **Stopped and not-given drugs are never named in `note_text`.** v0.1 G6 allowed "Stop X" in Plan, which Pulse's text path can re-extract as an order. They now live only in `confirm_prompts` (action stop/hold) and in provenance.
10. **Emission record.** Every consult in scope gets a record: `emission=full` or `emission=withheld` with a reason code (no_bundle, no_role_track, no_stt, never_queued, no_order_capable_span, validator_fail…). This makes the 64.6% coverage gap measurable per cause.
11. **QA block.** The machine-checked floors are carried in the artifact, with the inputs mode and model ids read back from calls, never typed.
12. **Enums verified.** DurationUnit DAYS|WEEKS|MONTHS|YEARS|HOURS (YEARS=4 and HOURS=5 read from Pulse code). YEARS is sent directly, no longer months×12.

## 1. Top-level shape
```
{
  schema_version: "eta.freescript.v1.0",
  artifact_id, supersedes, created_at,
  emission: { state: "full"|"withheld", reasons: [code...] },        // withheld → gp_extraction empty, note_text absent
  policy: { medicine_policy: "notes_only"|"taped_draft", advice_budget: {items, chars}, inputs_mode: "current"|"brief"|"brief_words" },
  generator: { name, version, code_sha256, prompt_sha256s{stageA,stageB}, models[{role, served_model_id, provider, zdr:true}], temperature, run_id },
  encounter: { eta_encounter_id, room, visit_date_ist, window_start, window_end, languages[], transcript{segment_count, diarised, english_source, stt_engines[]}, doctor{pulse_doctor_uid|null, specialty|null} },
  pulse_link: { type_of_prescription:"HOSPITAL_GP", individual_uid|null, hospital_uid|null, consult_uid|null, prescription_uid|null, draft_exists, link_status, link_basis },
  roster: [...],            // §2
  spans: [...],             // §3
  gp_extraction: {...},     // §4, exactly pulsepb.GPLlmExtraction; medicines [] under notes_only
  confirm_prompts: [...],   // §5
  doctor_words: [...],      // §6
  red_flags: [...],         // §7
  provenance: [...],        // §8, one per item incl. kept-out and withheld
  note_text: "...",         // §9
  qa: {...}                 // §10
}
```
Pulse ingests only `gp_extraction`, `note_text` and the header. It drops unknown keys, which is verified. Everything else is the audit and review layer and the scoring substrate.

## 2. Roster (fluid rooms)
One entry per diarisation label (bundle `speaker_N` space):
- `label`, `talk_s`
- `role`: treating_doctor | other_clinician | patient | attender | staff | translator | unknown
- `role_votes`: {role_track, clef, jev}, each a role or null
- `three_of_three`: bool
- `armc`: { state: pass|fail|off|blocked_contradiction, cos, margin_next_label, margin_runner_up_centroid, gate_flag: on|off }
- `voiceprint_match`: bool
- `translator_of`: label|null
- `order_capable`: bool

Rules (EB v3 §6.3 with the lead's rulings D2/N1/S7/M4):
- **Order-capable:** the 3/3 label, OR the armc-pass label with no contradiction.
- **Conflict:** a voiceprint match on any label other than the 3/3 label means NO label is order-capable.
- **Two 3/3 labels:** only the one arm (c) names; if arm (c) names neither, none.
- **No voiceprint available:** the 3/3 label alone, `case7_no_voiceprint` set.
- **Gate off:** arm (c) never contributes (bit-for-bit 3/3, Fable C3).
- Translator, staff, attender and patient labels are never order-capable.

## 3. Span registry
`spans[]` entries:
- `span_id`, `segment_refs[]`, `t0`, `t1`, `label`
- `lang`, `quote_native` (verbatim STT), `quote_en` (verbatim translation, never model prose)
- `span_source`: 3of3 | armc | both | none
- `order_capable` (from the roster, then the segment check below)
- `segcheck`: { cos, rank_first: bool } for armc-only spans
- `overlap`: { other_label, share } when speakers overlap

Segment check (A4.1a.8, Fable C2): an armc-only span that carries an order attribute must itself reach cos ≥0.65 to the logged-in centroid AND rank that centroid first; otherwise `order_capable=false` for that span.
Clip rule: spans outside the consult window or inside a quarantined boundary are never cited (clip leakage floor = 0).

## 4. `gp_extraction`
- Field-for-field `pulsepb.GPLlmExtraction`, unchanged, and ETA never adds keys.
- Under `notes_only`, `medicines` = [] and `surgeries`/`referrals` are held to supported items only. Investigations, diagnoses, symptoms, examination, advice, plan and follow-up post when supported.
- An item posts only if `support=supported`.
- Nothing is filled by inference. Whole-value missing statements and placeholders are withheld (`field_withheld`).
- `general_advice` stays a string. Live advice budget: 5 items / 300 chars, with must-carry red flags always kept on top.
- Under `taped_draft` (future, needs V plus fable): a medicine posts as a Pulse draft line only if the name, strength and frequency are each supported on order-capable spans, the generic is resolved, and there is no LASA flag. Otherwise it stays a prompt.

## 5. `confirm_prompts[]` (every medicine, and any order that cannot be supported)
- `prompt_id`, `kind`: medicine | investigation | procedure | referral
- `action`: start | continue | stop | hold | change_dose | not_given
- `drug`: (medicine only)
  - `spoken`, `brand_recognised|null`, `generic` (UPPERCASE INN), `components[]` (combination brands expand only when attested in the curated map, else `combination_unexpanded`)
  - `base_molecule` (salt and qualifier words stripped: acid, sodium, potassium, calcium, chloride, carbonate, vitamin, d3, duo, forte, sr, xr, er, pack…)
  - `form`, `strength_heard|null`
  - `lasa_risk`: { pair_with|null, note }, flagged on the curated LASA list (prednisolone/prednisone, hydroxychloroquine/hydroxyzine/hydrochlorothiazide, chloroquine/chlorpheniramine/chlorthalidone, amoxicillin/amoxiclav, extensible)
  - Name matching is whole-word on the base molecule, never on salt words. A split spelling ("hydroxy chloroquine") is normalised before matching.
- `attributes`: {strength, dose, route, frequency, duration, instruction}. Each is `{value|null, cited_spans[], support: supported|h_unattrib|unaligned|affirmed_from_patient|not_stated}`.
- `who_said`: label and role. `doctor_confirm_reason[]`: notes_only | untaped | not_order_capable | lasa | strength_unstated | translator_relay | stop_order | combination_unexpanded …
- Prompts are never rendered as orders. In `note_text` they appear only under Medication, as described in §9.

## 6. `doctor_words[]`
- `instruction_id`, `category` (dosing, lifestyle, diet, warning, follow_up, test_prep, counselling…)
- `text_en` (paraphrase-free: copied or minimally joined from cited spans)
- `cited_spans[]`
- `firmness`: firm | hedged (hedged is never rendered as firm)
- `final_position`: bool (only the last word on a topic renders; earlier contrary turns are recorded with `superseded_by`)
- `emphasis_count`, `counselling`: bool
- Feeds advice and plan rendering and counselling recall. In fluid rooms, only order-capable spans author doctor_words. A translator restating the doctor is linked via `relay_of`.

## 7. `red_flags[]`
- `text_en`, `cited_spans[]`, `must_carry: true`
- Always rendered first in General Advice and never trimmed by the budget. Missing a taped red flag is a validator failure (floor).

## 8. `provenance[]`
This is v0.1's record, extended:
- `item_id`, `kind`, `text`, `status` (prescribed | continued | stopped | not_given | discussed_only), `negated`
- `support`, `cited_spans[]`, `alignment` (aligned_code | aligned_llm | unaligned), `span_source`
- `json_pointer|null`, `prompt_id|null`, `withheld_reason|null`, `flags[]`
- Every posted item, every prompt, every kept-out item and every withheld field has exactly one record.
- Bare affirmation (Fable note on A4.1): a doctor's "yes" supports a patient-raised item only if that item is in the immediately preceding turn AND the doctor's span is order-capable. Attributes taken from the patient turn get `affirmed_from_patient`, and a drug or dose so taken is always a prompt.

## 9. `note_text`
- The 11 FreeScript headings, exactly once each, in order.
- Rendered only from posted `gp_extraction` plus `red_flags` plus `doctor_words`.
- **Medication section under notes_only:**
  - first line exactly `Draft list, not a prescription; the treating doctor checks each drug.`;
  - then one line per start/continue prompt as `GENERIC (Brand as spoken) strength-if-heard — confirm`;
  - nothing else;
  - stop, hold and not_given drugs are NEVER named anywhere in `note_text`; the Plan says `Medication changes discussed: see the confirm list.`
- No placeholders, brackets, reprs, "TBD" or "addressed to doctor" phrasing (the FRX-N1 list).
- Investigation, procedure and referral lines name only posted entries, one line each (v0.1 G6).

## 10. `qa` (machine-checked, written by the generator, re-checked by the validator)
- `floors`:
  - untaped_drugs = 0
  - invented_doses = 0
  - dose_precedence_errors = 0
  - clip_leakage = 0
  - placeholders = 0
  - red_flags_missing = 0
  - hallucinations_est (reported; cohort gate ≤0.2/consult)
  - validator_pass = true
- `counts`: items posted / prompts / withheld / h_unattrib / unaligned / affirmed_from_patient
- `inputs`: mode, role_votes present, armc gate state, case7
- `models_served`: read back from calls
- `render_template`: the neutral template id used for PDQI-9 judging (arm hidden)

## 11. Guarantees (validator-enforced; the generator refuses to write on failure)
- **V1–V6:** v0.1 G1–G6 carried forward (pointers resolve, one provenance per item, held-out orders never in lists under any held name, evidence or the no_evidence flag, 11 headings, one line per order entry).
- **V7:** under notes_only, `gp_extraction.medicines` is empty and every medicine provenance record has a `prompt_id`.
- **V8:** every posted item and every supported attribute cites ≥1 span with `order_capable=true` for order kinds, or any doctor span for note kinds. `affirmed_from_patient` never yields supported for a drug or dose.
- **V9:** no stopped, hold or not_given drug name (base molecule, brand, generic, alias, or a split spelling after normalisation) appears anywhere in `note_text`.
- **V10:** red flags are present and first in General Advice and survive the budget.
- **V11:** no placeholder, bracket, repr, missing-value-only value or FRX-N1 phrase in any posted string or in `note_text`.
- **V12:** span ids resolve, cited spans lie inside the window, and no cited span is boundary-quarantined.
- **V13:** roster consistency: at most one order-capable label set per the §2 rules, and the gate-off state means armc contributes nothing.
- **V14:** salt-word safety: no match decided on a qualifier word alone, and every LASA-listed name carries `lasa_risk`.
- **V15:** an emission=withheld artifact has a reason code, empty `gp_extraction` lists and no `note_text`.
- **V16:** models_served is non-empty, and every entry names a served model id.

## 12. How this maximises PDQI-9 (item → mechanism)
- **accurate:** only supported items post; per-attribute spans; LASA and salt safety; no invented doses.
- **thorough:** doctor_words plus counselling capture, red flags must-carry, prompts instead of silent drops, and an emission record so misses are visible.
- **up_to_date:** reversals resolved (final_position), stopped drugs as stop prompts, no stale continuation.
- **useful:** advice ordered by doctor priority and emphasis; prompts carry the confirm reason.
- **organized:** fixed 11 headings; grouping diagnosis → medicines by schedule → tests → advice → follow-up.
- **comprehensible:** generic in capitals with the brand in brackets; plain English; no reprs or placeholders.
- **succinct:** advice budget with must-carry first; one line per entry.
- **synthesized:** diagnoses tied to cited complaint and exam spans; plan lines cite their spans.
- **internally_consistent:** note_text is rendered only from the structured layers (one source); V1–V16.
The judges score from the neutral render. ETA never self-scores PDQI-9 in the artifact.

## 13. Open questions (Pulse, unchanged since 29 Sep; nobody has asked Pulse yet; routing via V to Kush)
Q1 transport, Q2 binding, Q3 draft vs submitted (Build overwrites doctor text), Q4 entry point (structured recommended), Q5 review UI for `confirm_prompts`, Q6 auth and idempotency, Q7 retention, Q8 gating roster, plus a new Q10: will Pulse accept one note line for an N-component combination brand (the brand-first gate R1)?
Clinical-owner question for V: generic first with the brand in brackets (IMC 2002) versus the brand as spoken first. The v1.0 default is generic first.

---

## Builder ASSUMPTIONs (each is the safer reading; none changes a design decision)

- **A1** The v0.1 `README-FOR-PULSE.md` and `HANDOFF-INDEX.md` are not in the repo; only the v0.1 vendor files (schema, validator, examples, mutants) are. The README style and index format were reconstructed from those files, and the privacy regex sweeps were re-defined in `HANDOFF-INDEX.md`.
- **A2** Provenance keeps v0.1's `names` and `confidence` (optional). v0.1's `evidence`, `speaker` and `speaker_source` are replaced by `cited_spans` plus the roster. V4 reads "evidence" as `cited_spans`.
- **A3** Spans carry two fields the design implies but does not list: `boundary_quarantined` (for V12) and `relay_of` (the translator span points at the doctor span it restates). `relay_of` sits on the span, not on `doctor_words`.
- **A4** `three_of_three` means all three role votes are `treating_doctor`. Arm (c) "names" a label when `armc.state=pass`, which requires `voiceprint_match`. With two 3/3 labels, a voiceprint match outside them is also a conflict. Case 7 is `qa.inputs.case7` and means every `armc.state=off`.
- **A5** A "doctor span" for note kinds is a span whose label role is `treating_doctor` or `other_clinician`.
- **A6** `doctor_words` must cite at least one order-capable span in every room, not only fluid rooms. In ex5, where no voice is order-capable, the advice stays out of `gp_extraction`.
- **A7** A discussed-only home drug is still a medicine, so V7 gives it a prompt. It is a `continue` prompt with reasons `patient_reported` (and `affirmed_from_patient` when the doctor only said "okay"). It is listed in Medication like any continue prompt, so the doctor sees it.
- **A8** A not-given investigation is a confirm prompt with action `not_given`. V3 and V9 cover every held order kind, not only drugs.
- **A9** `change_dose` prompts are not listed in Medication ("nothing else"). The Medication section is empty, with no draft line, when there is no start or continue prompt.
- **A10** The Medication line adds strength only when the brand string does not already carry it ("Augmentin 625 Duo" is not followed by "625"). An unattested combination with no generic renders the brand as spoken.
- **A11** FRX-N1 d1, d2 and d4 are not applied to Medication, because the design mandates "— confirm" there. d4 is reduced to its two regexes. "?" is allowed only as the Diagnoses prefix. The filler list adds `unknown` and `tbd` as whole values.
- **A12** The advice budget counts the items after the red flags, which are not counted. Items are split at sentence ends.
- **A13** `taped_draft` is in the schema, but V7 rejects any posted medicine under it. A posted medicine's attribute evidence has no home in v1.0 provenance, and the design says taped_draft needs sign-off first.
- **A14** V8 enforces "affirmed_from_patient never supports a dose" mechanically: a `supported` attribute's value (its digits and words of 3+ letters) must be heard in an order-capable cited span. A doctor's "okay" does not contain the dose.
- **A15** The `emission.reasons` and `withheld_reason` enums are closed lists of the codes the design names (plus `bracket` and `frx_n1_phrase` for withholding).
- **A16** V14 also checks that `base_molecule` equals the generic with qualifier words stripped, and that a combination is expanded only when the curated map attests it.
- **A17** The repo holds no list of the 16 L2 LASA pairs. `data/lasa_pairs.json` expands only the groups the design names into 8 pairs, and is extensible.
- **A18** The qa floors and counts are re-checked under the nearest rule: counts under V2; untaped, invented and dose-precedence floors under V8; red flags under V10; placeholders under V11; clip leakage under V12. Under V16, `qa.inputs.mode` must equal `policy.inputs_mode` and `models_served` must equal the generator's served ids.
- **A19** Example model ids, provider, STT and MT engine names are invented (`example-*`). The ex7 withheld artifact records one served model (stage A ran before the withhold), because V16 applies to every artifact.
- **A20** Schema failures print as `V0`. V5 also rejects a heading-shaped line outside the 11 (for example "Follow-up:").
- **A21** `GPLlmExtraction`'s description text was updated for v1.0. Its fields and nesting are identical to v0.1, except DurationUnit.
- **A22** In ex5 the staff label's three role votes all say treating_doctor (that is how it fools the vote), and its recorded role is `staff`. The voiceprint-matched label is the treating doctor.
- **A23** The brief's branch rule (`cloudpane/cloud-frx-v1-handoff/*`) was followed over the session's default branch.

---

## Fix round 1 (17 Oct): lead rulings and new Builder ASSUMPTIONs

Lead rulings, applied:
- **A5 changed.** Order kinds stand only on order-capable spans of the treating doctor's label (V8), and V13 now allows only a `treating_doctor` label to be order-capable. `other_clinician` spans support note kinds only.
- **A7 rejected.** A discussed_only medicine has no prompt and no Medication line; it lives only in provenance. V7 rejects a discussed_only medicine that carries a prompt. ex1 was fixed.
- **A9 changed.** `change_dose` is listed as `GENERIC (Brand) — dose change discussed — confirm`.
- **A11 narrowed.** Only the exact draft label line and the trailing ` — confirm` are exempt. d1, d2 and d4 (now ported in full) run on every other Medication-line character and on every drug field.
- **A17.** The 8 unordered LASA pairs are the 16 ordered pairs; the data file says so.
- A13, A14 and A22 accepted.

New Builder ASSUMPTIONs:
- **A24** A Medication line shows a strength only when the strength attribute is `supported`; `strength_heard` stays in the JSON but is never rendered on its own. For `change_dose` the shown value is the dose if supported, else the strength if supported.
- **A25** The medicine-name check (M1, V7) uses the GENERICS list of the current code, the brand map, the salt drugs, the LASA names and the artifact's own drug names. A name is allowed only in a diagnosis or comorbidity string that also holds a condition word (allergy, poisoning, induced, resistance and similar, in `data/medicine_names_min.json`). Held names (V9) are never allowed anywhere.
- **A26** Curly quotes and other Pi/Pf punctuation count as brackets. Non-ASCII letters, invisible characters, control characters and line breaks are rejected in every gp_extraction string, every rendered drug field and note_text.
- **A27** note_text must equal `render_note(artifact)` exactly. The renderer lives in the validator and the example builder uses it.
- **A28** Every advice item after the red flags must be a final_position doctor_words text, and doctor_words and red flag texts must be copied from their cited quotes (each 3+ letter word appears there).
- **A29** Fuzzy held-name matching (ratio ≥ 0.85) applies to held medicines only, on keys of 6+ letters; investigations match exactly after folding.
- **A30** A prompt's `who_said` label and role must match the roster (V12).
