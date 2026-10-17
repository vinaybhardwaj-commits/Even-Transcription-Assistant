# CHANGELOG: eta.freescript v0.1 → v1.0

This is a MAJOR version. The meaning of a medicine changed: in v0.1 a medicine in `gp_extraction` was a draft order, while in v1.0 (default `medicine_policy=notes_only`) no medicine is posted and every medicine is a doctor-confirm prompt. A v0.1 reader must not be pointed at v1.0 artifacts without the changes below.

Legend: **same** = unchanged, **changed**, **new**, **removed**.

## Header and top level

| Field | v0.1 | v1.0 | Change |
|---|---|---|---|
| `schema_version` | `"eta.freescript.v0.1"` | `"eta.freescript.v1.0"` | changed |
| `artifact_id` | UUID | UUID | same |
| `supersedes` | optional, string or null | required, UUID or null | changed (now required) |
| `created_at` | date-time | date-time | same |
| `emission` | none | `{state: full\|withheld, reasons[]}` | new |
| `policy` | none | `{medicine_policy, advice_budget{items, chars}, inputs_mode}` | new |
| `generator.prompt_sha256` | one sha256 | none | removed; see `prompt_sha256s` |
| `generator.prompt_sha256s` | none | `{stageA, stageB}` | new |
| `generator.model`, `model_provider`, `zdr` | one model, typed | none | removed; see `models[]` |
| `generator.models[]` | none | `[{role, served_model_id, provider, zdr: true}]`, read back from calls | new |
| `generator.run_id` | none | string | new |
| `generator.name`, `version`, `code_sha256`, `temperature` | as v0.1 | as v0.1 | same |
| `encounter.visit_date_ist` | none | `YYYY-MM-DD` | new |
| `encounter.transcript.stt_engines[]` | none | list of engine names | new |
| `encounter.doctor` | optional | required, `{pulse_doctor_uid\|null, specialty\|null}` | changed (now required) |
| other `encounter` fields | as v0.1 | as v0.1 | same |
| `pulse_link` (all 8 fields) | as v0.1 | as v0.1 | same |
| `roster[]` | none | one entry per diarisation label: role, role votes, 3/3, arm (c), voiceprint, translator_of, order_capable | new |
| `spans[]` | none | span registry: who spoke, verbatim quotes, span_source, order_capable, segcheck, overlap, boundary_quarantined, relay_of | new |
| `confirm_prompts[]` | none | every medicine and every order that cannot be supported, with a drug-naming block and per-attribute support | new |
| `doctor_words[]` | none | instructions with firmness, final position, emphasis, counselling | new |
| `red_flags[]` | none | `{text_en, cited_spans[], must_carry: true}` | new |
| `note_text` | required | required when `emission=full`, absent when `withheld` | changed |
| `qa` | none | floors, counts, inputs, models_served, render_template | new |

## `gp_extraction` (pulsepb.GPLlmExtraction)

| Field | v0.1 | v1.0 | Change |
|---|---|---|---|
| all fields and nesting | GPLlmExtraction | GPLlmExtraction | same |
| `LlmDuration.unit` | DAYS, WEEKS, MONTHS (years sent as MONTHS × 12) | DAYS, WEEKS, MONTHS, YEARS, HOURS (YEARS sent directly) | changed |
| `medicines` | prescribed and continued medicines | always `[]` under `notes_only` | changed (meaning) |
| what may post | provenance status prescribed or continued | provenance `support=supported` only; whole-value missing statements and placeholders withheld | changed |
| `general_advice` | free string | string; red flags first and never trimmed, then at most 5 items / 300 chars | changed (content rule) |

## `provenance[]`

| Field | v0.1 | v1.0 | Change |
|---|---|---|---|
| `item_id`, `kind`, `text`, `status`, `negated`, `json_pointer`, `flags` | as v0.1 | as v0.1 | same |
| `names` | optional | optional | same |
| `confidence` | required | optional | changed |
| `speaker`, `speaker_source` | required | none | removed; who spoke is the cited span's roster label |
| `evidence[]` | free-text quotes with times | none | removed; see `cited_spans` |
| `cited_spans[]` | none | span ids | new |
| `support` | none | supported, h_unattrib, unaligned, affirmed_from_patient, not_stated | new |
| `alignment` | none | aligned_code, aligned_llm, unaligned | new |
| `span_source` | none | 3of3, armc, both, none | new |
| `prompt_id` | none | id of the confirm prompt, or null | new |
| `withheld_reason` | none | placeholder, repr, missing_value, frx_n1_phrase, bracket, or null | new |
| `flags` values | 8 values | the 8 plus field_withheld, affirmed_from_patient, translator_relay, not_order_capable, lasa, combination_unexpanded, case7_no_voiceprint | changed (added values) |
| a prescribed item kept out of gp_extraction | not allowed | allowed only with a `prompt_id` or a `withheld_reason` | changed |

## `note_text`

| Rule | v0.1 | v1.0 | Change |
|---|---|---|---|
| headings | 11, in order, once each | the same | same |
| Medication section | one line per posted medicine | `Draft list, not a prescription; the treating doctor checks each drug.` then one `GENERIC (Brand) strength — confirm` line per start or continue prompt | changed |
| stopped / not-given orders | "Stop X" allowed under Plan | never named anywhere; Plan says `Medication changes discussed: see the confirm list.` | changed |
| placeholders, brackets, reprs, "TBD", FRX-N1 phrases | not checked | rejected (V11) | new |
| source | same content as gp_extraction | rendered only from posted gp_extraction, red_flags and doctor_words | changed |

## Guarantees

| v0.1 | v1.0 |
|---|---|
| G1 pointers resolve | V1, same |
| G2 one provenance per list entry | V2, extended to prompts, scalar fields and qa.counts |
| G3 held-out orders never in lists | V3, same match; held names now include the prompt's drug names and the brand map |
| G4 evidence or no_evidence flag | V4, evidence is `cited_spans` |
| G5 11 headings | V5, also rejects a heading-shaped line outside the 11 |
| G6 one line per order entry | V6, plus the exact Medication rendering |
| none | V7 to V16 (see README-FOR-PULSE.md) |
