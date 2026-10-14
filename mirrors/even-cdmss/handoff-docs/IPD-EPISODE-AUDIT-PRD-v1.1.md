# IPD Episode Audit — PRD v1.1 (2026-09-02)

**Status:** SPEC. All design decisions settled with V on 2026-09-01 and 2026-09-02. Zero open design issues. All grounding paths resolved. Ready for kickoff (§15).
**Supersedes:** `IPD-EPISODE-AUDIT-PRD-v1.0.md` in full. Where the two conflict, this document wins.
**Repository:** `github.com/vinaybhardwaj-commits/Even-CDMSS`. Next.js 15 App Router, npm, `node:test`, Vercel (bom1). **Branch `ipd-episode-audit` off `main`** (decision 31). The gate is the CI sequence in §14.
**Companions (REQUIRED reading for the builder):**
- `handoff-docs/EVEN-DB-REFERENCE-2026-09-01.md` — measured schema reference.
- `handoff-docs/EVEN-DB-REFERENCE-ADDENDUM-2026-09-02.md` — corrections measured on 2026-09-02. Where the addendum conflicts with the reference, the addendum wins.

---

## 0. Why

The IPD Audit section grades one discharge summary at a time. A discharge summary is written after the fact. It can be internally coherent and still be a poor account of the admission. The current engine cannot tell, because it never sees the rest of the stay.

The rest of the stay is in database 13. Measured on 2026-09-02 with exact joins: 1,349 admissions, 797 closed, 446 closed with progress notes. Of those 446, 411 have lab orders, 445 have billing rows, and 338 have a stored discharge extraction. Length of stay is short: 25 episodes at 0 days, 135 at 1 day, 218 at 2 to 3 days, 61 at 4 to 7 days, 7 at 8 to 14 days.

This PRD specifies a second IPD engine. It assembles the whole episode, builds a blinded expectation of how the admission should have run at each day boundary, compares real against expected, and reports where the real course left the expected one.

---

## 1. Decisions log

### 1.1 Settled with V on 2026-09-01 (v1.0, carried forward)

1. **Daily checkpoint regeneration.** An expected next-24-hours course at each day boundary, from everything known before that boundary.
2. **Two-pass scoring: blinded scores plus unblinded commentary.** Scores are produced with the outcome withheld. Commentary is produced with the outcome visible and never touches a number.
3. **Discharged episodes only.** Live episodes are out of scope.
4. **Single build through to the UI.** Mitigated by decision 12.
5. **Amazon Bedrock.** Haiku for checkpoints. Opus for diff, fidelity, and commentary. Model ids from environment variables.
6. **Checkpoint budget: daily for the first 7 days, then one episode-level checkpoint.** Refined in decision 24.
7. **Both score sets, computed independently.** Changed by decision 14. See there.
8. **Commentary is stored and shown on drill-in only**, behind a visible outcome-aware label.
9. **New tables, not an extension of `ipd_discharge_audits`.** (orchestrator)
10. **Findings carry an evidence tier and an `unassessable` verdict.** (orchestrator)
11. **Author attribution is two-layer.** (orchestrator)
12. **Ships behind `IPD_EPISODE_AUDIT_ENABLED`, default off.** The flag stays off until V reviews 20 episodes.

### 1.2 Settled with V on 2026-09-02 (v1.1)

13. **Discharge summary source: require an existing extraction.** An episode qualifies only when `discharge_extracted_cases` holds a row for its `ip_uid`. The new engine does not fetch PDFs and does not call Gemini. The nightly discharge worker grows the cohort. Reason: the summary is a PDF, and the extraction already exists for 338 of 446 candidate episodes.
14. **`care_value_index` is not computed by the episode engine.** The episode audit stores the divergence score set only. The UI shows the sibling `ipd-discharge-audit/0.2` score, joined on `ip_uid`, labeled as the discharge engine's score. Reason: `computeScorecard` needs findings in the discharge engine's shape, which the episode findings do not have. Decision 7's intent, two independent scores, is met by two independent engines.
15. **Blinding: two Opus passes.** Pass A1 scores divergence with no discharge summary at all. Pass A2 runs the fidelity check with the full extracted summary. V chose this over field-level withholding.
16. **Fidelity findings count in `divergence_index`.** A1 and A2 findings share one penalty. V chose this over a separate `fidelity_index`. Recorded trade-off: A2 findings are written with the outcome visible, so the headline score is not fully outcome-blind. The UI labels A2 findings as fidelity findings so a reader can subtract them.
17. **Drop the `kx_medicine_items` join.** Order events carry `ordered_item_name` and `service_type`. No category field. Reason: the join resolves 1.9 percent of blank pharmacy categories.
18. **Citations by retrieval per checkpoint.** Before each checkpoint, call the existing `retrieve()` with a query built per §3.3.2, top 8 chunks. `citation_ids` are `mksap_chunks` ids.
19. **Worker route, no cron in v1.** A route mirroring `app/api/ipd-audit/worker`. No `vercel.json` change. The orchestrator triggers it by hand for the validation run. A cron entry is a separate commit after V's clinical gate.
20. **Skip records live in a new table `ipd_episode_skips`.** Retried each tick until 14 days after discharge.

### 1.3 Orchestrator decisions on 2026-09-02 (design authority, recorded for audit)

21. **Never rewrite an id prefix.** `IPNO-n` and `IP-n` are different patients in 585 of 585 tested cases. Every join is exact on `encounter_id`. This is a hard constraint and a source-read test (§13 item 12).
22. **Closure comes from `kx_discharge_summary_records`.** `kx_ip_admissions` has no discharge column. Join `d.ipd_no = a.encounter_id`. `discharge_date_time` and `discharge_type` come from that row.
23. **No `uhid` hash.** The repo never hashes. PHI stays in database 13 and is joined at render time. The new tables store `encounter_id`, `ip_uid`, and `member_id` only, like `ipd_discharge_audits`.
24. **Checkpoint budget refined.** Daily checkpoints for `day_index` 0 to `min(los_days, 6)` inclusive, plus one episode-level checkpoint. LOS 0 gets one daily. LOS 1 gets two. LOS 6 or more gets seven. Reason: 78 percent of episodes close within 3 days, so the day 1 and day 2 checkpoints carry most of the signal.
25. **Episode-level checkpoint input.** All events except the discharge event. It predicts the remaining course and disposition from the last documented moment.
26. **`los_days = floor(hours between admission_date_time and discharge_date_time / 24)`.**
27. **Engine version `ipd-episode-audit/0.1`.**
28. **Prompt-size control.** Pharmacy billing rows roll up to one event per (day, `ordered_item_name`) with a count. Other billing rows stay one per row, capped at 60 per day by `order_date_time`, with a truncation note. Labs are one event per `order_no`.
29. **Progress notes are read by a new reader**, not by `fetchProgressNotes` in `lib/readmission/db13.ts`. That reader orders by `created_at`, which matches the clinical time in 20 percent of rows, and does not select the author fields.
30. **Note text passes through the repo's existing de-identifier** before it reaches an event summary or a prompt.

### 1.4 Settled with V on 2026-09-02, after v1.1 was drafted

31. **Build on branch `ipd-episode-audit`, not on main.** V chose this over the direct-to-main standing rule for this build. The builder creates the branch from the current `main`, commits there, and pushes the branch. Vercel builds a preview deployment. Preview and Production share the same `DATABASE_URL`, `METABASE_API_KEY`, and Bedrock variables (V confirmed), so the migration and the validation run on the preview URL write to the real Neon database. The branch merges to `main` after the orchestrator's verification in §14 passes and before V's clinical gate. The flag is off throughout, so the merge shows nothing to clinicians.
32. **No ask panel on the episode detail page in this build.** The existing discharge audit ask (`case-ask-panel.tsx`, `/api/admin/ipd-audit-ask`) stays as it is. An episode ask panel is deferred to v1.2, after V's 20-episode review. The builder must not add one.

33. **Whether an expected action happened is decided by code, not by the model (V, 2026-09-02).** Evidence: three identical runs of IP-1286 returned divergence_index 100, 80 and 84. The checkpoint layer was byte-identical across runs (md5 of expected_course, retrieval_query and citation_ids all matched), so the whole spread came from the Opus diff pass. In the same runs the judge marked 12, 11 and 8 findings `unassessable` although not one had an empty evidence basis and not one was Tier C. It was using the word to mean "the record does not show this, but it might have happened where I cannot see", which removes the finding from the score. Run 1 scored a flawless 100 while holding a written finding that no VTE prophylaxis was documented.

    The engine therefore splits the work. The checkpoint model proposes what to expect, and with each expectation emits a machine-checkable matcher and a severity, both produced while it is still blinded. Code then resolves each expectation against the assembled event list and assigns the verdict: present is concordant; absent while the data class exists in this episode is divergent; absent where the data class is missing from the mirror altogether is unassessable, and this is the only path that may produce that verdict; a class that exists but cannot settle the question, such as package billing hiding a dispensed drug, is context_dependent. Every finding records which of those four paths resolved it. The diff pass keeps only what code cannot decide: commission, timing, sequencing, and the appropriateness judgement on those. The fidelity pass is unchanged.

34. **Severity is proposed at generation time, before the outcome is known.** A consequence of decision 33. The checkpoint model attaches a severity to each expectation while blinded, so severity never depends on knowing whether the action happened or how the admission ended.

---

## 2. Pipeline

Seven stages. Each stage writes its output before the next stage starts.

1. **Select.** Find closed episodes that qualify. §3.1.
2. **Assemble.** Build the real course with per-claim provenance. §3.2.
3. **Checkpoint.** For each checkpoint: retrieve citations, then generate the blinded expected course with Haiku. §3.3.
4. **Diff (A1).** Opus compares real against expected. No discharge summary. §3.4.
5. **Fidelity (A2).** Opus compares the extracted discharge summary against the real course. §3.5.
6. **Comment (B).** Opus, outcome visible, prose only. §3.6.
7. **Persist.** One `ipd_episode_audits` row, N `ipd_episode_checkpoints` rows. §7.

---

## 3. Stage specifications

### 3.1 Select

An episode is a row of `kx_ip_admissions`. It qualifies when all of the following hold:

1. A row exists in `kx_discharge_summary_records` with `ipd_no = encounter_id` and `discharge_date_time` not null. If more than one row matches, take the one with the latest `_create_time`.
2. At least one row exists in `kx_clinical_template_progress_reports` with the same `encounter_id`.
3. A row exists in `discharge_extracted_cases` with `ip_uid = encounter_id`. Prefer `extraction_version = 'doc-extract/2'`, then `'doc-extract/1'`, then the latest `extracted_at`.
4. No row exists in `ipd_episode_audits` for `(encounter_id, engine_version)`.

If condition 1, 2, or 3 fails, write or update an `ipd_episode_skips` row with the failed condition and do not audit. If the episode's discharge is more than 14 days old and it is still skipped, stop retrying it. Condition 4 failing is a silent skip with no row.

Process qualifying episodes in ascending `discharge_date_time`.

### 3.2 Assemble the real course

The real course is an ordered list of events. Every event carries provenance. No event exists without a source record.

#### 3.2.1 Event schema

```json
{
  "event_id": "string",
  "occurred_at": "ISO 8601 UTC",
  "day_index": 0,
  "event_type": "admission|initial_assessment|note|order|lab_order|handover|ot_note|transfer|discharge",
  "summary": "string",
  "detail": {},
  "author_name": "string or null",
  "author_role": "string or null",
  "responsible_clinician_id": "string or null",
  "provenance": {
    "source_table": "string",
    "source_record_id": "string",
    "source_timestamp": "ISO 8601 UTC"
  },
  "evidence_tier": "A|B|C"
}
```

#### 3.2.2 Time base

`day_index` 0 starts at `kx_ip_admissions.admission_date_time`. Each boundary is 24 hours after the previous one. Store UTC. Display Asia/Kolkata.

Clinical timestamp per source, in this order:

| Source | Timestamp |
|---|---|
| admission | `kx_ip_admissions.admission_date_time` |
| note, handover, ot_note, initial_assessment | `progressnote_date_time` inside `component_json` (epoch milliseconds, see below), then `g_creation_time` (epoch milliseconds) |
| order | `kx_billing_records.order_date_time` |
| lab_order | `kx_lab_reports.sample_collection_date_time`, then `booking_date_time` |
| transfer | `kx_ip_transfers.created_at` |
| discharge | `kx_discharge_summary_records.discharge_date_time` |

`component_json` is `text` holding a JSON array of `{"name": ..., "valueString": ...}` objects. `progressnote_date_time` is the `valueString` of the element whose `name` is `progressnote_date_time`. It is present on 100 percent of progress notes. Read it with `jsonb_array_elements(component_json::jsonb)`.

**Never use `_create_time`, `_update_time`, or `created_at` for clinical ordering.** `_create_time` is the mirror write time. `created_at` agrees with the clinician-stated time within a minute on 20 percent of rows and is null on 148.

If no clinical timestamp resolves, set `evidence_tier` to C and exclude the event from checkpoint input.

#### 3.2.3 Sources and joins

All joins are exact on the id. **Do not transform, trim a prefix, or rewrite any id.** See decision 21.

| Event type | Source table | Join | Tier |
|---|---|---|---|
| admission | `kx_ip_admissions` | `encounter_id` | A |
| note | `kx_clinical_template_progress_reports` | `encounter_id` | A |
| order | `kx_billing_records` | `visit_id_admission_id = encounter_id AND patient_type = 'IP'` | A |
| lab_order | `kx_lab_reports` | `visit_id = encounter_id` | A |
| discharge | `kx_discharge_summary_records` | `ipd_no = encounter_id` | A |
| initial_assessment | `kx_clinical_template_initial_assessment_adults` | `encounter_id` | B |
| handover | `kx_clinical_template_shift_handovers` | `encounter_id` | B |
| ot_note | `kx_clinical_template_ot_notes` | `encounter_id` | B |
| transfer | `kx_ip_transfers` | `encounter_id` | B |

Column allow-lists per table. Select only these. A source-read test enforces it (§13 item 13).

- `kx_ip_admissions`: `encounter_id, uid, admission_date_time, admission_type, admit_source, ward, ward_type_name, billing_category, admitting_doctor_speciality, current_treating_doctor_speciality, treating_department_name, treating_sub_department_name, facility_name, admitting_doctor_id, current_treating_doctor_id, remarks, member_id`
- `kx_clinical_template_progress_reports` and the three other template tables: `_doc_id, encounter_id, facility_id, template_name, status, finalized_by_username, current_treating_doctor_id, ordering_doctor_id, g_creation_time, component_json`. OT notes add `surgery_name, surgeon`. Handovers add `handed_over_by, received_by, handover_route`.
- `kx_billing_records`: `_doc_id, visit_id_admission_id, order_date_time, service_type, department, service_item_name, ordered_item_name, ordered_qty, quantity, net_amt, status, order_no`
- `kx_lab_reports`: `_doc_id, visit_id, order_no, service_name, sub_department, priority, booking_date_time, sample_collection_date_time, report_date, icd_diagnosis`
- `kx_ip_transfers`: `_doc_id, encounter_id, created_at, transfer_type, transfer_reason, ward, vacant_ward_name, care_type, recommending_doctor_speciality`
- `kx_discharge_summary_records`: `_doc_id, ipd_no, discharge_date_time, discharge_type, admission_date_time, treating_doctor_speciality, _create_time`

Never select `patient_name, patient_age, patient_gender, birth_date, telecom, uhid, patient_mobile, mobile_no, age, gender, age_gender, address_details, kin_name, kin_contact, primary_email_address, secondary_email_address`. `uhid` is read only at UI render time, by the existing `namesForIpUids` pattern in `lib/ipd-audit/db13.ts`.

Order event rules (decision 17 and 28): pharmacy rows (`service_type = 'Pharmacy'`) roll up to one event per (day, `ordered_item_name`) with a count in `detail`. Other rows are one event each, capped at 60 per day, with `detail.truncated_count` on the last kept event. No category field.

Note event rules: `summary` is the concatenation of every `valueString` in `component_json` whose value is non-empty, excluding the names `esfewqf, Inver43, fycjtkuvyj, liubf, observationId, doctor_id, tag_data`. The text passes through the existing de-identifier used by `lib/stay-library` before storage. `author_role` is the `valueString` named `role`.

#### 3.2.4 Discharge summary

The discharge event carries `discharge_type` in `detail` and the extracted case (`extracted_json`) in `detail.extracted_case`. Assembly stores the whole event. Blinding is applied when inputs are built, per §3.3.3 and §3.4.1. Do not build a second assembly path.

### 3.3 Checkpoints (Haiku, blinded)

#### 3.3.1 Budget (decision 24)

| `los_days` | Daily checkpoints | Episode-level |
|---|---|---|
| 0 | day 0 | 1 |
| 1 | days 0, 1 | 1 |
| 2 to 5 | days 0 to `los_days` | 1 |
| 6 or more | days 0 to 6 | 1 |

#### 3.3.2 Retrieval (decision 18)

Before each checkpoint, call `retrieve(query, { ... })` from `lib/retrieve.ts` with default normative sources and `k = 8`. Build `query` from, in order: `treating_department_name`, `admission_type`, `admit_source`, admission `remarks`, and the first 400 characters of the most recent note or initial assessment summary before the cutoff. Number the returned chunk excerpts 1 to k in the prompt. `citation_ids` are the chunk `id` values. On retrieval failure, proceed with no excerpts and record `retrieval_failed = true` on the checkpoint row.

#### 3.3.3 Blinding rule

The day N checkpoint receives: the admission event, and every other event with `occurred_at` strictly earlier than the start of day N. Nothing else.

It never receives: the discharge event, the extracted case, `discharge_date_time`, `discharge_type`, `los_days`, any event with `day_index >= N`, or any other checkpoint.

The episode-level checkpoint receives every event except the discharge event (decision 25). Same exclusions otherwise.

Build every input by filtering the assembled event list. Record `input_cutoff_at` and `input_event_count` on the checkpoint row.

#### 3.3.4 Output schema

```json
{
  "expected_diagnostics": [{"item": "string", "by_day": 0, "rationale": "string", "citation_ids": []}],
  "expected_therapeutics": [{"item": "string", "by_day": 0, "rationale": "string", "citation_ids": []}],
  "expected_monitoring": [{"item": "string", "frequency": "string", "rationale": "string", "citation_ids": []}],
  "escalation_triggers": [{"trigger": "string", "action": "string", "citation_ids": []}],
  "expected_los_days": 0,
  "expected_disposition": "string",
  "uncertainty": ["string"]
}
```

An entry with an empty `citation_ids` is allowed. §4.4 caps any finding built on it.

### 3.4 Diff pass A1 (Opus, outcome-blinded)

#### 3.4.1 Input

Every event except the discharge event, plus all checkpoints. No extracted case. No `discharge_type`, `los_days`, `discharge_date_time`, readmission, or mortality field.

Recorded limit: the event list ends where documentation ends, so A1 can infer approximate duration. It cannot see the disposition.

#### 3.4.2 Finding schema

```json
{
  "finding_id": "string",
  "pass": "divergence|fidelity",
  "finding_type": "omission|commission|timing|sequencing",
  "verdict": "divergent|context_dependent|unassessable|concordant",
  "domain": "diagnostics|therapeutics|monitoring|escalation|documentation|disposition",
  "day_index": 0,
  "checkpoint_ref": "string or null",
  "statement": "string",
  "severity": "minor|moderate|major",
  "evidence_tier": "A|B|C",
  "evidence_basis": [{"source_table": "string", "source_record_id": "string", "source_timestamp": "..."}],
  "author_name": "string or null",
  "author_role": "string or null",
  "responsible_clinician_id": "string or null",
  "lvc_category": "string or null",
  "citation_ids": []
}
```

- **omission**: a checkpoint expected an action and no matching event exists.
- **commission**: an event happened that no checkpoint expected and no later evidence justifies.
- **timing**: the expected action happened later than expected.
- **sequencing**: expected actions happened in an order that inverts a stated dependency.

A1 findings carry `pass = 'divergence'` and a non-null `checkpoint_ref`.

`lvc_category` uses `LVC_CATEGORIES` from `lib/opd-lvc-classify-core.ts` (12 values). Populate only on commission findings in the therapeutics or diagnostics domains. Validate with `asCategory()` from the same file.

### 3.5 Fidelity pass A2 (Opus, summary visible)

Input: every event including the discharge event, and the full extracted case. No checkpoints.

Output: findings in the §3.4.2 schema with `pass = 'fidelity'`, `domain = 'documentation'`, `finding_type = 'commission'`, `checkpoint_ref = null`. One finding per clinical claim in the extracted case that no assembled event supports. `evidence_basis` cites the discharge record and, where relevant, the events that contradict the claim.

A2 must not emit findings in any other domain. Findings that break this rule are dropped in code and counted in `n_dropped_invalid`.

### 3.6 Commentary pass B (Opus, outcome-aware)

Input: everything, including the outcome and all findings from A1 and A2. Output:

```json
{
  "narrative": "string",
  "outcome_context": "string",
  "findings_context": [{"finding_id": "string", "note": "string"}]
}
```

This pass emits no scores, verdicts, severities, or new findings. It may annotate findings that A1 or A2 produced. If the output contains a numeric score field or a `finding_id` that does not exist, retry once. On second failure, store null.

### 3.7 Model calls

Every call goes through `governedChat(traceId, label, params, { bedrock: model })` from `lib/trace.ts`. No other client. `params` is an OpenAI-style chat request. JSON is parsed by a local `extractJsonObject` in the engine's pure core, following the pattern in `lib/lvc-value-core.ts`.

Models come from environment variables, validated with `assertKnownBedrockModel` before any work starts:

| Variable | Default | Used by |
|---|---|---|
| `IPD_EPISODE_CHECKPOINT_MODEL` | `global.anthropic.claude-haiku-4-5-20251001-v1:0` | §3.3 |
| `IPD_EPISODE_JUDGE_MODEL` | `global.anthropic.claude-opus-4-6-v1` | §3.4, §3.5, §3.6 |

Prompts are top-level `const` template literals named `IPD_EPISODE_CHECKPOINT_SYSTEM`, `IPD_EPISODE_DIFF_SYSTEM`, `IPD_EPISODE_FIDELITY_SYSTEM`, `IPD_EPISODE_COMMENTARY_SYSTEM`, in one pure file, so the reasoning registry picks them up. See §11 for the registration steps.

---

## 4. Evidence tiers and the unassessable verdict

### 4.1 Tiers

| Tier | Sources |
|---|---|
| A | `kx_ip_admissions`, `kx_clinical_template_progress_reports`, `kx_billing_records`, `kx_lab_reports` order metadata, `discharge_extracted_cases` with `kx_discharge_summary_records` |
| B | `kx_clinical_template_initial_assessment_adults`, `kx_clinical_template_shift_handovers`, `kx_clinical_template_ot_notes`, `kx_ip_transfers` |
| C | lab result values, radiology reports, medication administration times, pre-admission outpatient notes |

Tier C sources are absent or near-absent in the mirror.

### 4.2 The grading rule

A finding whose `evidence_basis` is empty or contains only Tier C sources cannot carry `divergent`. Code rewrites it to `unassessable` and increments `n_unassessable`. This is a code validation after the model returns, not a prompt instruction.

### 4.3 Unassessable findings are reportable

They are an output. The UI lists them under their own heading.

### 4.4 Uncited expectations

An A1 finding whose referenced checkpoint entry has an empty `citation_ids` is capped in code at `severity = 'minor'` and `verdict = 'context_dependent'`. This cap does not apply to A2 findings.

---

## 5. Author attribution

- **Author** = `finalized_by_username` plus the `role` value from `component_json`.
- **Responsible clinician** = `current_treating_doctor_id`.

Every note-derived finding carries both. Documentation-domain findings attribute to the author. All other domains attribute to the responsible clinician.

Normalize `finalized_by_username` by trimming whitespace and collapsing `Dr.` to `Dr`. Do nothing more.

---

## 6. Scoring

### 6.1 Divergence index

```
penalty = 8 * n_major + 4 * n_moderate + 1 * n_minor
divergence_index = max(0, 100 - penalty)
```

Only findings with `verdict = 'divergent'` contribute, from both passes (decision 16). Counters stored: `n_findings, n_divergence_pass, n_fidelity_pass, n_omission, n_commission, n_timing, n_sequencing, n_divergent, n_context_dependent, n_unassessable, n_concordant, n_low_value, n_dropped_invalid`. `n_low_value` is the count of findings with a non-null `lvc_category`.

### 6.2 Completeness

```
completeness_pct = round(100 * sources_present / 9)
```

The nine sources are the five Tier A sources and the four Tier B sources in §4.1. A source is present when at least one row joined. Selection requires three of them, so the floor is 33.

### 6.3 Care value index

Not computed here (decision 14). The UI joins `ipd_discharge_audits` on `ip_uid = encounter_id` with `engine_version = 'ipd-discharge-audit/0.2'` and shows `care_value_index` and `band` under the label `Discharge engine score`. If no row exists, show `not audited by discharge engine`.

---

## 7. Data model

Three new tables. All additive. No existing table changes.

### 7.1 `ipd_episode_audits`

| Column | Type |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `audited_at` | timestamptz not null default now() |
| `app_source` | text |
| `engine_version` | text not null |
| `encounter_id` | text not null |
| `ip_uid` | text not null |
| `member_id` | text |
| `facility_name` | text |
| `speciality` | text |
| `admitted_at` | timestamptz |
| `discharged_at` | timestamptz |
| `los_days` | integer |
| `discharge_type` | text |
| `extraction_version` | text |
| `divergence_index` | integer |
| `completeness_pct` | integer |
| `n_findings` … `n_dropped_invalid` | integer, one column per counter in §6.1 |
| `checkpoint_count` | integer |
| `evidence_tiers` | jsonb, `{"A": [tables present], "B": [...], "C": []}` |
| `real_course` | jsonb |
| `findings` | jsonb |
| `commentary` | jsonb |
| `model_checkpoint` | text |
| `model_judge` | text |
| `trace_id` | text |
| `de_identified` | boolean default true |

Unique index on `(encounter_id, engine_version)`.

`speciality` = `current_treating_doctor_speciality`, else `admitting_doctor_speciality`. `facility_name` from the admission row.

### 7.2 `ipd_episode_checkpoints`

| Column | Type |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `episode_audit_id` | uuid references `ipd_episode_audits(id)` on delete cascade |
| `day_index` | integer not null |
| `checkpoint_type` | text not null, `daily` or `episode` |
| `generated_at` | timestamptz not null default now() |
| `input_cutoff_at` | timestamptz not null |
| `input_event_count` | integer |
| `retrieval_query` | text |
| `retrieval_failed` | boolean default false |
| `citation_ids` | integer[] |
| `expected_course` | jsonb |
| `status` | text, `ok` or `error` |
| `error_detail` | text |
| `model` | text |
| `trace_id` | text |

Index on `episode_audit_id`.

### 7.3 `ipd_episode_skips`

| Column | Type |
|---|---|
| `encounter_id` | text not null |
| `engine_version` | text not null |
| `reason` | text not null, one of `no_discharge_summary, no_notes, no_extraction, diff_failed, fidelity_failed` |
| `first_seen` | timestamptz not null default now() |
| `last_seen` | timestamptz not null default now() |
| `attempts` | integer not null default 1 |
| `discharged_at` | timestamptz |

Primary key `(encounter_id, engine_version)`. Upsert on conflict: set `reason`, `last_seen = now()`, `attempts = attempts + 1`.

### 7.4 De-identification

No `uhid`, patient name, age, gender, birth date, mobile, or address in any of the three tables. `real_course[].summary`, `findings[].statement`, and `commentary` pass through the existing de-identifier. Names are joined at render time only.

---

## 8. Failure modes

Every path degrades to a recorded no-op. No path returns a 500. No path writes a wrong value.

| Condition | Behavior |
|---|---|
| No discharge summary row | Skip. Reason `no_discharge_summary`. |
| No progress notes | Skip. Reason `no_notes`. |
| No extraction | Skip. Reason `no_extraction`. |
| Skipped and discharge older than 14 days | Not selected again. Row stays. |
| Metabase query fails | Abort this episode. No audit row. No skip row. Log. Continue to the next episode. |
| Retrieval fails | Checkpoint proceeds with no excerpts. `retrieval_failed = true`. |
| Bedrock call fails | Retry twice with exponential backoff. Then checkpoint row `status = 'error'` and continue. |
| Unparseable JSON | Same as a call failure. |
| Every checkpoint errored | Skip. Reason `diff_failed`. No audit row. |
| A1 fails after retries | Skip. Reason `diff_failed`. No audit row. |
| A2 fails after retries | Skip. Reason `fidelity_failed`. No audit row. |
| B fails after retries | Audit row written with `commentary = null`. |
| B output has a score field or an unknown `finding_id` | Retry once. Then null. |
| Finding fails the Tier C rule | Rewrite to `unassessable`. Count. |
| A2 finding outside documentation domain | Drop. Count in `n_dropped_invalid`. |
| Unknown `lvc_category` value | Set null. |
| No clinical timestamp for a record | Tier C. Excluded from checkpoint input. |
| Already audited at this version | Silent skip. |
| Worker lock held | Return `{ok: true, locked: true}`. Do nothing. |

---

## 9. Feature flag

`IPD_EPISODE_AUDIT_ENABLED`, read as `process.env.IPD_EPISODE_AUDIT_ENABLED === '1'` at request time. Default off.

When off: every UI route in §10 returns 404, and the link from the IPD Audit page is not rendered. The worker route still runs. The flag gates the interface, not the pipeline.

---

## 10. UI

Inside the existing IPD Audit section, mirroring its page shell.

**List** at `/admin/ipd-audit/episodes`: encounter, speciality, length of stay, `divergence_index`, discharge engine score with band, finding counts, completeness. Sortable on divergence index and discharge engine score. Server component, admin cookie gate, direct store calls, same as `app/admin/ipd-audit/page.tsx`.

**Detail** at `/admin/ipd-audit/episodes/[id]`, in this order:

1. Header: `divergence_index`, discharge engine score labeled `Discharge engine score`, completeness percentage, patient name resolved at render time by the existing `namesForIpUids` pattern.
2. Timeline of the real course grouped by day, each event showing its source table.
3. Findings grouped by day. Each shows pass (`divergence` or `fidelity`), type, domain, severity, verdict, evidence tier, author, responsible clinician.
4. A block titled **Could not assess** holding `unassessable` findings.
5. A collapsed block titled **Outcome-aware commentary**, with this text verbatim above the content: `This commentary was written with knowledge of the patient outcome. The scores above were not.`
6. A collapsed block per checkpoint showing the expected course and its citations.

Empty findings copy: `No divergence found against the expected course.`

Entry point: a link `Episode audits` on `app/admin/ipd-audit/page.tsx`, rendered only when the flag is on. Add `/admin/ipd-audit/episodes` to the `match` array of the IPD entry in `components/Shell.tsx`.

---

## 11. File contract

**Create ONLY these files:**

- `migrations/0051_ipd_episode_audits.sql` — the three tables in §7, all `IF NOT EXISTS`.
- `app/api/admin/migrate-ipd-episode-audits/route.ts` — idempotent admin route issuing the same DDL, gated like `app/api/admin/migrate-ipd-audits/route.ts`, returning `{ok, steps}`.
- `lib/ipd-episode/db13.ts` — database 13 readers via `metabaseQuery`, column allow-lists from §3.2.3, exact joins only.
- `lib/ipd-episode/assemble-core.ts` — pure: event building, day index, ordering, roll-ups, blinding filters.
- `lib/ipd-episode/assemble.ts` — impure: calls readers and the de-identifier, returns the course.
- `lib/ipd-episode/checkpoint-core.ts` — pure: budget, retrieval query builder, prompt, output parsing.
- `lib/ipd-episode/checkpoint.ts` — impure: `retrieve()` and `governedChat`.
- `lib/ipd-episode/judge-core.ts` — pure: A1, A2, B prompts, parsing, Tier C rule, uncited cap, A2 domain drop, commentary validation, penalty math, completeness.
- `lib/ipd-episode/judge.ts` — impure: the three Opus calls.
- `lib/ipd-episode/prompts.ts` — the four prompt constants from §3.7.
- `lib/ipd-episode/store.ts` — Neon reads and writes, `IPD_EPISODE_ENGINE_VERSION`, extraction reader by `ip_uid`, skip upsert, sibling score lookup.
- `lib/ipd-episode/run.ts` — pipeline orchestrator for one episode.
- `app/api/ipd-episode/worker/route.ts` — mirrors `app/api/ipd-audit/worker/route.ts`: `maxDuration = 800`, `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, auth by `x-vercel-cron` or `CRON_SECRET` or admin cookie, `?max=` default 2 cap 5, sequential processing, `app_settings` lock key `ipd_episode_lock` with the same TTL mechanics as the IPD worker, `?encounter=` to run one named episode.
- `app/admin/ipd-audit/episodes/page.tsx` and `ui.tsx`.
- `app/admin/ipd-audit/episodes/[id]/page.tsx` and panel components in that folder.
- `lib/__tests__/ipd-episode-*.test.ts` — tests per §13.

**Additive edits ONLY:**

- `lib/reasoning/manifest.ts` — add the four prompt ids to `PROMPT_MANIFESTS` with `maturity: 'draft'`.
- `lib/__tests__/reasoning-registry.test.ts` — update the count invariant for four new prompts.
- `data/reasoning-registry/prompts.generated.json` — regenerate with `npm run reasoning:registry`.
- `lib/architecture/map.generated.ts` — regenerate with `npm run architecture:map`.
- `app/admin/ipd-audit/page.tsx` — the flag-gated link.
- `components/Shell.tsx` — the `match` entry.
- `.env.example` or the environment typing file, if one exists — the three variables in §3.7 and §9.

**UNTOUCHED (hard):**

- `opd_note_audits` and every OPD engine file.
- `lib/ipd-audit/*`, `ipd_discharge_audits`, `discharge_extracted_cases`, and the discharge engine. Read only.
- `lib/value-score-core.ts` and every scoring policy module.
- `lib/trace.ts`, `lib/bedrock.ts`, `lib/bedrock-core.ts`, `lib/llm.ts`, `lib/retrieve.ts`, `lib/metabase.ts`, `lib/db.ts`.
- `lib/admin-gate.ts`, `lib/admin-cookie.ts`, every auth guard.
- `vercel.json`, `.github/workflows/*`.
- `package.json`, `package-lock.json`. No new dependencies.

---

## 12. Grounding facts (resolved 2026-09-02)

| Fact | Value |
|---|---|
| Repository | `github.com/vinaybhardwaj-commits/Even-CDMSS` |
| Discharge engine | `lib/ipd-audit/run.ts` (`runIpdAudit`), store `lib/ipd-audit/store.ts`, db13 readers `lib/ipd-audit/db13.ts`, billing `lib/ipd-audit/billing.ts` |
| `care_value_index` formula | `lib/value-score-core.ts` `computeScorecard`. Not used by this engine (decision 14). |
| `uhid` hash | Does not exist. Omission posture (decision 23). |
| Bedrock | `lib/bedrock.ts`, allowlist `BEDROCK_MODELS` in `lib/bedrock-core.ts`, env `BEDROCK_REGION, BEDROCK_ROLE_ARN, BEDROCK_OIDC_AUDIENCE, GCP_SA_KEY`. Engines call `governedChat` only. |
| Neon | `lib/db.ts` `sql`, env `DATABASE_URL` |
| Database 13 | `lib/metabase.ts` `metabaseQuery`, `DB13 = 13`, env `METABASE_URL, METABASE_API_KEY` |
| Worker pattern | `app/api/ipd-audit/worker/route.ts` |
| Migration pattern | `migrations/0013_ipd_discharge_audits.sql` plus `app/api/admin/migrate-ipd-audits/route.ts` |
| Retrieval | `lib/retrieve.ts` `retrieve(query, opts)`, chunk `id` is the citation id |
| lvc enum | `lib/opd-lvc-classify-core.ts` `LVC_CATEGORIES`, `asCategory` |
| De-identifier | the `Deidentifier` used by `lib/stay-library/core.ts` |
| Render-time names | `namesForIpUids` in `lib/ipd-audit/db13.ts` |
| Flag pattern | `process.env.X_ENABLED === '1'` |
| Prompt registry | `scripts/reasoning-registry-gen.mjs`, manifest `lib/reasoning/manifest.ts` |

---

## 13. Tests

Pure-core tests under `lib/__tests__/`, `node:test`, no database, no network. About 32 cases.

1. Day index: admission at 23:50, event at 00:10, correct index. UTC storage.
2. Blinding cutoff: the day N input excludes every event at or after the boundary. Admission event always included. Six cases including boundary equality.
3. Episode-level input excludes the discharge event and nothing else.
4. Checkpoint budget: `los_days` 0, 1, 2, 5, 6, 7, 30 produce 1, 2, 3, 6, 7, 7, 7 daily plus 1 episode.
5. Divergence index: penalty math, floor at zero, non-divergent verdicts contribute nothing, A1 and A2 findings both count.
6. Tier C rule: only-C rewritten, mixed A and C not rewritten, empty basis rewritten.
7. Uncited cap: applies to A1 with an uncited entry, does not apply to A2.
8. A2 domain drop: a fidelity finding in therapeutics is dropped and counted.
9. Completeness: nine-source denominator, all present, minimum three present.
10. Author attribution: documentation finding to author, therapeutics finding to responsible clinician. `Dr.` normalization.
11. Commentary rejection: score field rejected, unknown `finding_id` rejected.
12. **Source-read: no id rewriting.** Read `lib/ipd-episode/db13.ts` and `assemble-core.ts` as text and assert none of `replace(`, `IPNO-`, `ERN-`, `regexp_replace(` appear.
13. **Source-read: PHI.** Read `lib/ipd-episode/db13.ts` and assert none of the forbidden columns in §3.2.3 appear, and that `_create_time` appears only in the discharge summary tiebreak.
14. Timestamp preference: `progressnote_date_time` from the `{name, valueString}` array wins over `g_creation_time`. `created_at` and `_create_time` never used.
15. Pharmacy roll-up: three rows of one item on one day become one event with count 3. Non-pharmacy cap at 60 with truncation note.
16. Skip retry window: a skip with discharge 15 days old is not selected.
17. Model env: an unknown model id fails before any work.

---

## 14. Verification plan

**Builder gate, before push, in this order (the CI sequence):** `npm run architecture:check`, `npm run architecture:map` then `git diff --exit-code lib/architecture/map.generated.ts`, `npm run reasoning:registry` then `git diff --exit-code data/reasoning-registry/prompts.generated.json`, `npm run reasoning:governance`, `npm run changelog:coverage`, `npm run typecheck`, `npm test`, `npm run build`. All green or no push.

**Orchestrator, after the branch push, in order:**

1. Fetch the branch and read the diff against `main`. Confirm the file contract in §11: only listed files created, only listed edits, nothing in the UNTOUCHED list changed.
2. Watch the Vercel preview deploy for branch `ipd-episode-audit` to READY. Record the preview URL. All steps below run against it.
3. Run `/api/admin/migrate-ipd-episode-audits` on the preview URL through V's admin session. Confirm `{ok: true}` and the three tables in Neon.
4. Validate every inferred SQL string from the builder report against database 13 and Neon.
5. Run the worker on the preview URL with `?max=2` repeatedly until 20 episodes are audited, flag off.
6. Recompute `divergence_index` for 3 episodes from the stored `findings` by independent query. Demand exact agreement.
7. Confirm no forbidden column value appears in any of the three tables.
8. Confirm every daily checkpoint row has `input_cutoff_at` equal to the day boundary and `input_event_count` equal to the count of events before it. This is the blinding proof.
9. Confirm no finding with only Tier C evidence carries `divergent`.
10. Confirm every audited `encounter_id` exists in `kx_ip_admissions` with the same `ip_uid` in `discharge_extracted_cases`.

**MERGE (V):** when steps 1 to 10 pass, V merges `ipd-episode-audit` into `main` with a merge commit, no squash, no rebase, and deletes the branch. The production deploy then carries the feature with the flag off. If any step fails, the fix goes to the same branch and steps 1 to 10 run again.

**VALIDATION GATE (V, blocking):** V reviews the 20 audited episodes on production. The flag stays off until he says otherwise. The cron entry waits for the same word.

---

## 15. Kickoff (paste into Claude Code)

```
Read handoff-docs/IPD-EPISODE-AUDIT-PRD-v1.1.md fully and build it exactly.
Read handoff-docs/EVEN-DB-REFERENCE-2026-09-01.md and
handoff-docs/EVEN-DB-REFERENCE-ADDENDUM-2026-09-02.md. Both are REQUIRED.
Where the addendum conflicts with the reference, the addendum wins.
v1.1 supersedes v1.0 in full. Ignore any v1.0 copy you find.

All design decisions are settled in PRD section 1. Do not re-open them.
If something is unsettled, flag it prominently in your report. Do not improvise.

BRANCH: start on this machine's `main` as it is. Do not pull or reset main.
Run:
  git checkout main
  git push origin main            (so the orchestrator's baseline matches yours)
  git fetch origin handoff/ipd-episode-audit
  git checkout -b ipd-episode-audit
  git merge --no-edit origin/handoff/ipd-episode-audit
The merge brings in only the three handoff-docs files named above. Then read
them. Commit on ipd-episode-audit only. Never commit to main. Push with `git push -u origin ipd-episode-audit` ONLY when the full
gate in PRD section 14 passes: architecture:check, architecture:map
regenerated and committed, reasoning:registry regenerated and committed,
reasoning:governance, changelog:coverage, typecheck, npm test, npm run build.
If any step fails, fix before any push. Do not merge. Do not open a pull
request. The orchestrator verifies the preview deployment and V merges.

GROUND YOURSELF FIRST. Read these before writing code:
- lib/ipd-audit/run.ts, store.ts, db13.ts, billing.ts: inherit the persistence
  pattern, the metabaseQuery usage, the PHI posture (names joined at render
  time, never stored), and namesForIpUids.
- app/api/ipd-audit/worker/route.ts: mirror its maxDuration, auth, lock, and
  ?max= mechanics exactly.
- lib/trace.ts governedChat, lib/bedrock-core.ts BEDROCK_MODELS and
  assertKnownBedrockModel, lib/lvp-operator-core.ts and lib/lvp-operator.ts for
  the model-env-var pattern.
- lib/reasoning/manifest.ts and scripts/reasoning-registry-gen.mjs: how a
  prompt constant is registered.
- lib/retrieve.ts retrieve(): the citation source.
- lib/stay-library/core.ts: the Deidentifier you must reuse. Do NOT reuse its
  created_at ordering.
- lib/opd-lvc-classify-core.ts: LVC_CATEGORIES and asCategory.
- migrations/0013_ipd_discharge_audits.sql and
  app/api/admin/migrate-ipd-audits/route.ts: the migration pattern.
- lib/__tests__/ipd-audit-billing.test.ts: the source-read test pattern.

FILE CONTRACT = PRD section 11 exactly. Create only the listed files. Additive
edits only where listed. The UNTOUCHED list is hard.

HARD CONSTRAINTS:
- Never rewrite, trim, or transform an encounter id. IPNO-n and IP-n are
  different patients. Every join is exact. A source-read test enforces this.
- Select only the columns in PRD 3.2.3. Never select a PHI column. A
  source-read test enforces this.
- Never order clinical events by _create_time, _update_time, or created_at.
  Use progressnote_date_time from the component_json {name, valueString}
  array, then g_creation_time.
- Every model call goes through governedChat with { bedrock: model }. No
  other client. assertKnownBedrockModel before any work.
- No new dependencies. No changes to vercel.json, package.json, auth guards,
  lib/ipd-audit/*, lib/trace.ts, lib/retrieve.ts, lib/value-score-core.ts.

SQL/SCHEMA HONESTY: your sandbox has NO live database. Every query and every
column name you write is INFERRED, including those copied from the reference
documents. (a) Every such path is fail-safe: an error degrades to a recorded
skip or an empty result, never a 500 and never a wrong value. (b) List EVERY
SQL string and column name VERBATIM in your report. The orchestrator validates
each against the live system before any user sees this feature.

NORMATIVE DETAILS (restated so nothing is guessed):
- Engine version: ipd-episode-audit/0.1
- Selection: kx_ip_admissions a; closure = kx_discharge_summary_records d with
  d.ipd_no = a.encounter_id AND d.discharge_date_time IS NOT NULL (latest
  _create_time if several); notes = kx_clinical_template_progress_reports with
  the same encounter_id; extraction = discharge_extracted_cases with
  ip_uid = encounter_id, prefer doc-extract/2, then doc-extract/1, then latest
  extracted_at. Skip reasons: no_discharge_summary, no_notes, no_extraction,
  diff_failed, fidelity_failed. Retry skips until 14 days after discharge.
- Joins: kx_billing_records.visit_id_admission_id = encounter_id AND
  patient_type = 'IP'; kx_lab_reports.visit_id = encounter_id; all
  kx_clinical_template_* and kx_ip_transfers on encounter_id.
- los_days = floor(hours(admission_date_time -> discharge_date_time) / 24).
- Checkpoints: daily for day_index 0..min(los_days, 6) inclusive, plus one
  episode-level. Day N input = admission event + events with occurred_at
  strictly before the start of day N. Episode-level input = every event except
  the discharge event. No checkpoint ever sees the discharge event, the
  extracted case, discharge_type, los_days, or discharge_date_time.
- Retrieval per checkpoint: retrieve(query, defaults) k=8; query from
  treating_department_name, admission_type, admit_source, remarks, and the
  first 400 chars of the latest note before the cutoff. citation_ids = chunk
  ids. Retrieval failure -> proceed, retrieval_failed = true.
- Pass A1 (divergence): every event except discharge + all checkpoints. No
  extracted case, no discharge_type, no los_days, no discharge_date_time.
  Findings pass = 'divergence', checkpoint_ref non-null.
- Pass A2 (fidelity): every event including discharge + full extracted case,
  no checkpoints. Findings pass = 'fidelity', domain = 'documentation',
  finding_type = 'commission', checkpoint_ref = null. Any other domain is
  dropped in code and counted in n_dropped_invalid.
- Pass B (commentary): everything. Prose only. A score field or an unknown
  finding_id -> retry once -> null.
- divergence_index = max(0, 100 - (8*major + 4*moderate + 1*minor)) over
  findings with verdict = 'divergent' from BOTH passes.
- completeness_pct = round(100 * sources_present / 9).
- Tier C rule: evidence_basis empty or only Tier C -> verdict rewritten to
  unassessable in code. Uncited-entry cap: A1 finding on a checkpoint entry
  with empty citation_ids -> severity minor, verdict context_dependent. Not
  applied to A2.
- Enums: finding_type omission|commission|timing|sequencing; verdict
  divergent|context_dependent|unassessable|concordant; domain
  diagnostics|therapeutics|monitoring|escalation|documentation|disposition;
  evidence_tier A|B|C; pass divergence|fidelity; lvc_category from
  LVC_CATEGORIES, only on commission findings in therapeutics or diagnostics.
- Order events: pharmacy rows roll up per (day, ordered_item_name) with a
  count; other rows one each, capped at 60 per day with a truncation note. No
  category field. No kx_medicine_items join.
- Note summary: concatenate non-empty valueString values from component_json,
  excluding names esfewqf, Inver43, fycjtkuvyj, liubf, observationId,
  doctor_id, tag_data. Pass through the stay-library Deidentifier.
- Author = finalized_by_username (trim, Dr. -> Dr) + role valueString.
  Responsible clinician = current_treating_doctor_id. Documentation findings
  attribute to the author, all others to the responsible clinician.
- Models: IPD_EPISODE_CHECKPOINT_MODEL default
  global.anthropic.claude-haiku-4-5-20251001-v1:0; IPD_EPISODE_JUDGE_MODEL
  default global.anthropic.claude-opus-4-6-v1. Prompts are top-level consts
  IPD_EPISODE_CHECKPOINT_SYSTEM, IPD_EPISODE_DIFF_SYSTEM,
  IPD_EPISODE_FIDELITY_SYSTEM, IPD_EPISODE_COMMENTARY_SYSTEM in
  lib/ipd-episode/prompts.ts, registered in lib/reasoning/manifest.ts.
- Tables: ipd_episode_audits (unique on encounter_id, engine_version),
  ipd_episode_checkpoints, ipd_episode_skips (pk encounter_id,
  engine_version). Columns per PRD section 7. No uhid, no names, no age, no
  gender, no mobile, anywhere.
- UI: /admin/ipd-audit/episodes and /admin/ipd-audit/episodes/[id]. Both
  return 404 unless process.env.IPD_EPISODE_AUDIT_ENABLED === '1'. The
  discharge engine score is read from ipd_discharge_audits where
  ip_uid = encounter_id and engine_version = 'ipd-discharge-audit/0.2' and
  labeled "Discharge engine score". Commentary block carries the verbatim
  label in PRD section 10.
- Worker: app/api/ipd-episode/worker/route.ts, maxDuration 800, ?max= default
  2 cap 5, sequential, app_settings lock key ipd_episode_lock, ?encounter= to
  run one episode. No cron entry. Flag gates the UI only.

REPORT: branch name and sha; each gate step and its result; every SQL string and column name
verbatim; the four prompt texts verbatim; confirmation that every checkpoint
and pass input is built by filtering the single assembled event list;
confirmation that no id is rewritten anywhere; the migration route V must
run; any deviation or flagged decision, prominently, at the top.
```
