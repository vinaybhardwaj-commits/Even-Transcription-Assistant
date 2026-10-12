# eta2freescript — ETA consult transcript → FreeScript artifact (v2: stageA-v2 · mapper 2.3.0 · stageB-v4 · eta.freescript.v0.3)

Turns one isolated OPD consult (an ETA cut clip with its Sarvam transcript and, when present, the REB `role.llm-roles`
track) into a draft encounter for Pulse FreeScript: an `eta.freescript.v0.3` artifact holding `gp_extraction`
(= `pulsepb.GPLlmExtraction`), `note_text` under the 11 FreeScript headings, per-item `provenance`, a
`completion_required` list for the doctor, and a `clip_boundary` verdict.

The pipeline runs **off Vercel**, on the box. It reads a local folder. Only the model calls leave the process, and
`phi_guard.py` allows nothing but Bedrock Anthropic Claude on the `converse` route. A Scribe door
(`scribe_freescript`, `POST /api/freescript/ingest`, migration 0157) can store the artifact afterwards. That door is
**on unless `ETA_FREESCRIPT` is 0** (unset = on; that value is the kill switch). Transcript text is not stored.

Ported from the v1 prototype (`encounter-to-rx`, 35-consult scale-up, 11 Oct 2026). The prototype's v0 and v1 prompts
are kept unchanged under `prompts/` for reproducibility. The vendored w38 validator, schema and examples sit unchanged
under `vendor/freescript-w38/`.

## Flow

```
<data>/<uid>/transcript.json (Sarvam)  +  <data>/<uid>/role.json (REB role.llm-roles, optional)
        │ ingest.py      join roles onto turns: exact (t0,t1,speaker) → largest same-speaker overlap → extras.map → unknown
        │                attender → attendant; staff / other kept (v0.2). No role track → roles inferred by Stage A.
        │                English pass used when present (--english auto); native / code-mixed segments otherwise.
        ▼
boundary.py (pre)   two_consults flag (+gap_at_s), second patient voice at a clip edge, long gap with a stranger
        │           → quarantined turns, shown to Stage A as "[QUARANTINED: possible other consult]"
        ▼
Stage A  prompts/stageA-v2.md (Bedrock Sonnet, T=0) → even.encounter.v2 JSON (encounter.json)
        ▼
boundary.py (post)  + Stage A's consult_boundary.foreign_turns (topic discontinuity)
guard.py            citations; DOCTOR DOSE PRECEDENCE; numeric support (no number not on the cited tape)
        ▼
mapper.py           hold-back, coarser-parent diagnoses, unspoken routine panels dropped, combination brands
        │           split into components (brand kept), surgery flag + procedure name, spoken regimen carried,
        │           social drop, advice cap, typed follow-up, quarantine,
        │           sparse fields → kept-out review items + completion_required
        ▼
Stage B  prompts/stageB-v4.md (Bedrock Sonnet, input = gp_extraction + flags only) → note_text
        ▼
sanitize_note → validate.py (v0.3 schema + vendored G1–G6 on the v0.1 projection + C1–C4 + FRX-*)
        │  LLM note invalid (or the call failed) → deterministic note_text. Still invalid → artifact NOT written.
        ▼
<out>/<uid>/artifact.json  (+ artifact.v0.1.json projection, artifact.validation.json, encounter.json, stageA.raw.txt)
```

Rules kept from the prototype: the hold-back rule (an order reaches `gp_extraction` only with `basis: said` and a
doctor decision turn), the dose guard, `phi_guard`, `sanitize_note` (no filler lines), the vendored validator, and the
deterministic note fallback.

### What v2 changes

| # | Change | Where |
|---|---|---|
| 1 | Input is the Sarvam transcript plus the REB role track. Without a role track, roles are inferred and `speaker_source` is `model_inferred`. Native-script / code-mixed transcripts work, and the English pass is optional. | `ingest.py`, `pipeline.role_context` |
| 2 | Follow-up always carries a vendor `FollowUpType`, plus a `followup_date` computed from the stated interval or date. | `followup.py` |
| 3 | The doctor's stated strength beats a brand or strength the patient names (the "Dolo 650" vs "paracetamol 1 g" failure). A patient-only strength is nulled, and a conflicting brand number is stripped (the original is kept as `*_as_heard`). | `guard.dose_precedence` |
| 4 | Diagnoses: one primary and at most 3 secondaries. A symptom is not a separate diagnosis unless the doctor names it as one, and near-duplicates are merged. | `mapper.Builder.diagnoses` |
| 5 | Social and place detail is dropped from the presenting complaint unless Stage A marks it `clinically_relevant`. | `mapper.Builder.presenting` |
| 6 | Advice is limited to items said aloud by the doctor, near-duplicates are merged, and the total is capped at 5 items / 300 characters. | `mapper.Builder.advice` |
| 7 | Clip-boundary guard: turns from the previous or next patient are quarantined. Orders citing them are kept out with `[boundary_quarantine]` and the `boundary_quarantined` flag, and the artifact is flagged. | `boundary.py`, mapper |
| 8 | Sparse fields are never guessed. Each one becomes a kept-out review item and a `completion_required` entry. | mapper |

### Validator rules added for v0.2 (`validate.py`)

- **C1:** every `completion_required.item_id` names a kept-out provenance item.
- **C2:** no `boundary_quarantined` item is in `gp_extraction`.
- **C3:** every quarantined turn is inside the transcript.
- **C4:** a note order line names no kept-out order that its own entry does not also name. Instructions, investigation text and referral notes are scrubbed of kept-out drug names before render. If the deterministic fallback would still fail C4, that free text is dropped and the note is rendered again, so a fallback always writes an artifact.

C4 closes a G6 gap. G6 checks that each line names its own entry, not that it names nothing else. A drug absent from the
whole artifact still cannot be caught without a drug lexicon; the judge's `stage_b_additions` counts those.

## Folder contract (input)

One folder per consult uid. **Real consults live only on the box. Never commit one and never copy one to the cloud.**

```
<data>/<uid>/transcript.json   {consult_uid, clip:{t0_ms,t1_ms,room_slug}, language_code, model_translate,
                                english_segments:[{t0_ms,t1_ms,speaker_id,text}],
                                native_segments:[{t0_ms,t1_ms,speaker_id,text,lang}]}   (either list may be absent)
<data>/<uid>/stt.json          optional palimpsest stt track; native segments when transcript.json has none
<data>/<uid>/role.json         optional REB role.llm-roles track (layer "role", engine "llm-roles", status "ok"):
                                segments:[{t0_ms,t1_ms,speaker,role}], extras:{map, attender_present,
                                two_consults:{flag,gap_at_s}|bool, diar_partial}, config_hash
<data>/<uid>/meta.json         optional {room, specialty, consult_uid, prescription_uid, link_status, link_basis}
<data>/<uid>/signed.json       eval only: the signed Pulse note, normalised (see eval/judge.py)
```

A role track whose status is not `ok`, or whose layer or engine is wrong, is ignored. The consult then runs as
`model_inferred`.

## Run

Python 3.11+. From the repo root:

```bash
python -m pip install -r tools/eta2freescript/requirements-bedrock.txt   # jsonschema + boto3 (AWS creds/region from env)

# pipeline: one consult, several, or the whole folder
python -m tools.eta2freescript run --consult <uid> --data /path/to/consults --out /path/to/out
python -m tools.eta2freescript run --all --data /path/to/consults --out /path/to/out --workers 5

# eval against signed notes (Opus judge-v3, cached), then the headline table
python -m tools.eta2freescript eval --data /path/to/consults --out /path/to/out --judge opus
python -m tools.eta2freescript aggregate --out /path/to/out          # → <out>/eval/headline.json

python -m tools.eta2freescript validate /path/to/out/*/artifact.json
```

`eval` judges every consult in `--data` that has both an artifact in `--out` and a `signed.json` (`--consult UID...` narrows
it), and skips the rest with a reason. The useful run flags are:

- `--client bedrock|gateway|replay`: `gateway` uses the box `evengw`, with `ETA2FS_EVENGW_PATH` pointing at its directory. `replay` reads stored outputs from `--replay DIR`.
- `--english auto|on|off`: whether to use the English pass.
- `--no-role-track`: ignore `role.json`, to A/B test the role track.
- `--no-stage-b`: deterministic note only.
- `--stage-a-version v1|v2` and `--stage-b-version v3|v4`: choose prompt versions.

Model ids default to the global inference profiles `global.anthropic.claude-sonnet-4-6` and
`global.anthropic.claude-opus-4-6-v1`. Override one with `ETA2FS_BEDROCK_SONNET`, `ETA2FS_BEDROCK_OPUS` or
`ETA2FS_BEDROCK_HAIKU`. A non-Claude override is refused (exit 2) before any transcript is read.

Outputs are written with umask 077. `<out>/usage.jsonl` records tokens and USD per call (counts only, never text).

The offline replay over the synthetic fixtures is what CI effectively runs:

```bash
F=tools/eta2freescript/tests/fixtures
python -m tools.eta2freescript run --all --data $F/consults --client replay --replay $F/model --out /tmp/e2fs --workers 1
python -m tools.eta2freescript eval --data $F/consults --client replay --replay $F/model --out /tmp/e2fs --workers 1
python -m tools.eta2freescript aggregate --out /tmp/e2fs
```

## Scribe door

On unless `ETA_FREESCRIPT` is 0. The Python pipeline still does not run on Vercel.

- `scribe_freescript` `action=read` with one selector (`encounter_id` or `consult_uid`, `ist_date` alone, `room`+`date` (or `ist_date`), or `doctor_uid8`+range) returns the stored artifact, `completion_required` and the validator status. A rejected run is `state: rejected` with the FRX codes.
- `scribe_freescript` `action=run` (needs invoke) queues a `freescript` job. The box drains it; the Vercel step only waits.
- `POST /api/freescript/ingest` stores one result (HMAC `FREESCRIPT_INGEST_SECRET`, same shape as the Timbre ingest). A transcript-shaped field is refused.
- `GET /api/freescript/day?ist_date=YYYY-MM-DD` is the `eta2freescript_offline` hook: stored artifacts for that IST day (same HMAC, `FREESCRIPT_INGEST_SECRET`). 404 when `ETA_FREESCRIPT` is 0. No Pulse write.
- `python -m tools.eta2freescript.nightly run` posts an artifact for every sealed consult that day, plus folders that already have a Sarvam transcript and a role track. See `NIGHTLY.md`.

## Box reads

Read-only. No Pulse write. The Sarvam and role routes are not behind `ETA_FREESCRIPT`.

| route | auth env | query |
|---|---|---|
| `GET /api/sarvam/consult-results` | Bearer `REB_INDEX_READ_TOKEN` or `REB_INDEX_TOKEN` | `ist_date` or `consult_uids` (comma, max 25). `sealed=1` keeps sealed rows. `include_text=1` opts into transcript text (default is heads). |
| `scribe_sarvam` `action=consult_result` | the Scribe MCP token (read) | `consult_uid`, `consult_uids[]`, or `ist_date`. Same heads. `include_text` for text. |
| `GET /api/reb/roles` | Bearer `REB_INDEX_READ_TOKEN` or `REB_INDEX_TOKEN` | `consult_uid`, `consult_uids`, or `ist_date`. REB `role.llm-roles` from R2: roles and times only. Does not flip `ETA_REB_ROLE_LLM`. |
| `GET /api/freescript/day` | HMAC `FREESCRIPT_INGEST_SECRET` (`x-freescript-ts`, `x-freescript-signature` over `` `${ts}.GET ${path}?${query}` ``) | `ist_date`. The offline hook. |

Unset bearer tokens are 503 `not_configured`. A mismatch is 401.

## The `completion_required` contract

`completion_required` is a top-level list in the artifact. Each entry tells the doctor what the tape did not supply.
Nothing in it is ever guessed into `gp_extraction`.

```json
{"kind": "pick_drug", "item_id": "slot7", "prompt": "Name this drug", "detail": "gel twice a day x two weeks"}
```

| kind | raised when | where it points |
|---|---|---|
| `pick_drug` | a regimen was said without a drug name ("apply this gel twice a day") | a `slots[]` entry (`json_pointer` null), not a guessed medicine |
| `drug_history` | a current patient-reported catalogue drug the doctor did not already order. A near-miss brand of an ordered drug (Concord / Concor) is the same drug and raises no prompt. Names that are not catalogue-like are one shared note, not one prompt each | `[drug_history] <name>`; prompt `Continue <name>?`, or one `Patient mentioned other medicines` |
| `exam_missing` | no examination finding was said aloud, or a part was examined with no finding said | `[exam_missing] …` |
| `dose_unstated` | an emitted medicine has no stated strength, frequency or duration | `[dose_unstated] <name> - strength, duration not said aloud`; `detail` = the medicine's item_id |
| `follow_up_unstated` | a follow-up was said with no interval or date (type not IF_REQUIRED) | `[follow_up_unstated] …`; `detail` = the follow-up item_id |
| `follow_up_missing` | nothing about follow-up was heard. No default is invented | a kept-out follow-up item, `evidence_state` `not_said_in_room` |
| `surgery_confirm` | a procedure was discussed only conditionally ("if not better") | the conditional procedure item; it is not a recommendation and the surgery flag stays false |
| `inferred_confirm` | an inferred order or diagnosis, offered for one tap | the inferred item (`json_pointer` null, confidence ≤ 0.6) |
| `allergy_check` | an allergy was heard in the room | the allergy item in `room_facts` |
| `boundary_review` | the clip may hold another patient's consult | the first `boundary_quarantined` item, or a `clip_boundary` item when nothing was quarantined; `detail` = the reasons |

Guarantees, enforced by the validator:

- every `item_id` resolves to a kept-out provenance item or to a pick-drug slot (C1, FRX-C1);
- nothing quarantined is in `gp_extraction` (C2);
- the note never names a kept-out order (G6 + C4).

A consumer should block signing until each entry is resolved or dismissed by the doctor.

`clip_boundary` is `{suspected, quarantined_turns[], reasons[]}`. These are the reasons:

| reason | what it means |
|---|---|
| `role_track_two_consults` | quarantine applied |
| `role_track_two_consults:no_gap` | flag only |
| `role_track_two_consults:gap_outside_clip` | flag only |
| `second_patient_voice` | quarantine applied |
| `second_patient_voice:interleaved` | flag only |
| `second_patient_voice:unconfirmed` | flag only (a late second patient voice, with no Stage A foreign label) |
| `long_gap` | quarantine applied to turns Stage A labelled as another consult, or (with no labels) to an early short side that has a speaker the rest of the clip does not. A turn Stage A left as the current patient is never quarantined |
| `long_gap:unconfirmed` | flag only (late short side, or no stranger speaker) |
| `stage_a_topic` | quarantine applied |
| `stage_a_topic:unlocalised` | flag only |

## Follow-up

Stage A emits `follow_up {type, interval{value,unit}, date, when, condition, with_reports, with_referral}`.
`followup.py` maps it to the vendor `LlmFollowUp`:

- **Type:** `followup_type` is one of the vendor `FollowUpType` values. When Stage A gives none, it is inferred:
  - reports and a referral → `FOLLOW_UP_WITH_REPORT_AND_REFERRAL_PRESCRIPTION`;
  - reports only → `FOLLOW_UP_WITH_REPORTS`;
  - a referral only → `FOLLOW_UP_WITH_REFERRAL_PRESCRIPTION`;
  - a condition only ("come back if…") → `IF_REQUIRED`;
  - otherwise → `MANDATORY_FOLLOW_UP`.
- **Date:** `followup_date` is the visit date (clip start, IST) plus the interval. Month arithmetic clamps to the month end, and a year counts as 12 months. A stated date is used only if it is valid and not before the visit.
- **Interval:** `LlmFollowUp` has no interval field, so the interval goes into `follow_up_instructions` ("Review after 2 weeks"). Pulse receives the interval as text plus a computed date.

## Schema notes (v0.2 bump)

`schema/eta-freescript-artifact.v0.2.schema.json` is generated from the vendored v0.1 by `schema/build_v02.py`. CI
fails if the committed file is stale (`python -m tools.eta2freescript.schema.build_v02 --check`).

1. **Speakers: attender → attendant, plus staff / other.**
   - The vendored artifact speaker enum is `doctor|patient|attendant|unknown`. It has no `staff`, and it spells
     `attendant` where the REB role track says `attender` (REB: doctor/patient/attender/staff/other/unknown).
   - At ingestion (`ARTIFACT_SPEAKER` in `ingest.py`), REB `attender` is mapped to `attendant`. Stage A's inferred roles
     take the same map, so an `attender` string never reaches the artifact.
   - v0.2 adds `staff` and `other` to `ProvenanceItem.speaker`, and `speaker_source: role_track`. A staff or other turn
     validates as v0.2; the v0.1 projection (`to_v01` → `artifact.v0.1.json`) remaps staff/other to `unknown` and
     `role_track` to `diarisation`, so the vendored validator and a v0.1 consumer still accept the projection. A raw
     v0.2 artifact with `speaker: staff` handed to the v0.1 schema without projection fails the enum check — that is
     why the bump exists. Covered by `tests/test_schema_notes.py`.
   - v0.2 also adds the required top-level `completion_required` and `clip_boundary`, `encounter.transcript.speaker_source`
     / `role_track`, the provenance kind `clip_boundary`, and the flags `boundary_quarantined` and
     `doctor_dose_precedence`. These need a new version because v0.1 has `additionalProperties: false`.
2. **DurationUnit: MONTHS×12 vs YEARS.**
   - The enum file actually vendored (`vendor/freescript-w38/eta-freescript-artifact.schema.json`, `LlmDuration.unit`)
     is `DAYS|WEEKS|MONTHS` only, range 1–1000. Its description says: "Years are emitted as MONTHS x 12."
   - Pulse code has a `YEARS` `DurationUnit`. That is a real discrepancy: following Pulse would write `unit: "YEARS"`
     into `gp_extraction`, which the vendored schema (and therefore the G-rules) rejects.
   - This tool follows the vendored file. `mapper.duration` converts YEARS → MONTHS×12 ("diabetes for 5 years" →
     60 MONTHS). v0.2 deliberately does NOT widen the unit, so every v0.2 `gp_extraction` stays valid against v0.1.
   - Cost of following the vendor: the doctor's unit is lost ("60 months" where they said "5 years"), and the 1–1000
     range caps a duration at 83 years; anything longer is kept in provenance only.
   - **Decision (open question 1, 2026-10-12).** The default stays MONTHS×12, because that passes both the vendored
     w38 schema and Pulse. v0.3's schema allows `YEARS`. Set `ETA_FREESCRIPT_EMIT_YEARS=1` to emit YEARS once Pulse
     confirms; unset or `0` keeps the conversion. An unrecognised value raises. `to_v01` rewrites a representable
     YEARS value back to MONTHS×12 so the w38 validator still passes. 90 YEARS is not representable as MONTHS
     (1080 > 1000) while the switch is off.

## Pulse-side needs (owned by Pulse)

1. **Structured ingest endpoint.**
   - `hospitalGPMapper.Build` is unexported, so there is no way to hand Pulse a `GPLlmExtraction` without going through its Gemini extractor, which re-extracts from text and carries its known defects.
   - Pulse needs an exported, draft-only ingest that takes `gp_extraction` plus `note_text`. It should bind on `pulse_link.consult_uid`; the ETA consult uid is taken as the Pulse `consult_uid` with `link_status: probable`, unverified per consult.
   - It must not overwrite content the doctor has already typed.
2. **Review UI for `completion_required`.**
   - "Name this drug" for each regimen slot: show the captured form, frequency and duration, and let the doctor pick the drug in one tap.
   - A "Continue X?" prompt only when the doctor discussed continuing or stopping that drug, or it is a current chronic medicine relevant to the diagnosis. Other patient-mentioned names are one "Patient mentioned other medicines" note.
   - "Enter finding" for a missing exam, and "enter dose" for an unstated dose.
   - A boundary banner showing the quarantined items.
   - In v1, 83% of signed drugs were never named aloud, so this UI is the main lever on drug recall.
3. **P0 security, before any ingest is switched on.**
   - `parsePrescription` lacks server-side checks for ownership (the caller owns the consult), draft state (the prescription is still a draft) and the feature flag.
   - Signed prescription PDFs are served from public URLs.
   - Both must be fixed before ETA output can reach a prescription.
4. **Enums.** Confirm `FollowUpType` and `DurationUnit` (see the schema notes). Also decide whether ICD codes need a field; `GPLlmExtraction` has none, so the ICD suggestion stays in provenance text.
5. **ZDR.** `generator.zdr: true` assumes the Bedrock account does not retain prompts. That is the Bedrock default, but the account setting is unconfirmed.

## v1 baseline (prototype, 35 consults, 8 specialties, 53 signed drugs)

| Measure | v1 |
|---|---|
| Signed drugs never named aloud | 44/53 (83%) |
| Drug recall, named aloud | 7/9 |
| Drug precision | 8/12, 0 without tape support |
| Regimen-slot capture, regimen-only drugs | 18/21 |
| Hallucinations | 6 (0.17 per consult) |
| Validator, final | 35/35; Stage B LLM note without fallback 29/35 |
| Cost | Sonnet drafting ~$0.07/consult; Opus judging ~$0.07/consult |

v2 has not yet been run on real consults. The numbers above are the prototype's, and the targets for v2 are the v2
rules. Rerun `run` + `eval` + `aggregate` on the box set and compare `headline.json` against this table. `judge-v3` adds
`completion_review` (is each completion item needed?), `[boundary_quarantine]` verdicts, `dx_oversplit`,
`advice_too_long` and `follow_up.type_ok`.

## Tests

```bash
python -m pip install -r tools/eta2freescript/requirements.txt
python -m pytest -c tools/eta2freescript/pytest.ini tools/eta2freescript/tests -q
```

CI runs this in `.github/workflows/eta2freescript-tests.yml`, only when `tools/eta2freescript/**` changes. The suite:

- uses only `FakeClient` / `ReplayClient`, never imports boto3, and makes no network call;
- runs on three SYNTHETIC consults, generated by `tests/fixtures/build_fixtures.py`, with no real person, number or uid;
- checks that the fixtures regenerate byte-identically;
- scans the whole tool for the identity shapes the repo bans (doctor slug, person fields, "Dr X", emails, clinician ids, phone and Aadhaar shapes).

## Files

| path | role |
|---|---|
| `__main__.py` | CLI: run / eval / aggregate / validate |
| `ingest.py` | folder contract, role-track join, native fallback, Stage A transcript format |
| `boundary.py` | clip-boundary signals and quarantine |
| `guard.py` | citations, doctor dose precedence, numeric support (English + Hindi number words) |
| `followup.py` | FollowUpType and date |
| `mapper.py` | encounter v2 → artifact v0.2 |
| `note.py` | headings, `sanitize_note`, deterministic note |
| `validate.py` | v0.2 schema, v0.1 projection, vendored G1–G6, C1–C4 |
| `pipeline.py` | one consult end to end |
| `models.py` | Bedrock / gateway / replay / fake clients, usage ledger |
| `phi_guard.py` | Bedrock Claude converse only |
| `prompts/` | stageA-v0/v1/**v2**, stageB-v0…v3/**v4**, judge-v0…v2/**v3** |
| `eval/` | `judge.py` (judge + metrics + results.csv), `aggregate.py` (headline.json + cost) |
| `schema/` | `build_v02.py` and the generated v0.2 schema |
| `vendor/freescript-w38/` | the w38 validator, v0.1 schema, examples and mutants, unchanged |
| `tests/` | unit tests, synthetic fixtures |
