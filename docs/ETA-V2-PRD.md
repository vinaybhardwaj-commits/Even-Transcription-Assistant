# ETA v2 — Multi-Note-Type & Allied Health Expansion

**Status:** Scoping
**Author:** V + Claude
**Date:** 28 May 2026
**Predecessor:** ETA v1 (tag `eta-v1-complete` at `7eac196`, 27 May 2026)
**Target ship:** Sprints V2.S0–V2.S8 (~6–8 weeks if dedicated)

---

## 1. Executive Summary

ETA v1 ships a working voice-to-note pipeline for **one user type** (physician at a clinic visit) producing **one note type** (Medical Encounter Note). Internal review and use of the v1 product have surfaced two structural limits:

1. **Note-type rigidity.** Physicians don't only do clinic visits. The same physician needs a different note format for an operative procedure, a general medical/inpatient note, and other contexts. The v1 schema and CDMSS pipeline force-fit everything into a clinic-encounter shape, silently dropping fields that don't have a slot.
2. **Clinician-type rigidity.** Dietitians and physiotherapists at Even Hospital perform structured patient consultations whose documentation would benefit equally from voice-to-note. They cannot use v1 — the model is doctor-centric (URL `/dr-<slug>`, schema is `MedicalEncounterNote`, KB is internal-medicine).

v2 expands ETA to support **5 distinct note types** across **3 clinician types** (physician, dietitian, physiotherapist), with **note-type-aware** LLM prompting, schema, CDMSS routing, email templates, and recipient defaults. The database is generalized from a `doctor` table to a `clinician` table. The knowledge base is generalized from one MKSAP corpus to a tagged multi-source corpus with retrieval routed by encounter type.

v2 ships zero regressions for v1 users: existing physicians, recordings, and admin surfaces continue to work exactly as today.

---

## 2. Why v2

### 2.1 The forced-fit problem

The v1 note schema has 9 fields hardcoded to a clinic encounter shape:

```
chief_complaint, history_present_illness, past_medical_history,
current_medications, allergies, examination, assessment,
plan.{investigations, treatment, follow_up}
```

When a surgeon dictates an operative note, qwen2.5:14b force-fits the content into this schema. Procedure narrative ends up in `examination` (wrong). EBL, fluids, specimens, anesthesia type, surgical team, complications, counts, disposition, antibiotics — none have a slot and are silently dropped. The output looks plausible but is **medico-legally incomplete** as an operative record.

When a dietitian dictates a nutrition consult, anthropometric data force-fits into `examination`, diet plans flatten into `plan.treatment` bullets losing meal-by-meal structure, and CDMSS retrieves internal-medicine evidence that's tangential at best and confusingly off-topic at worst.

### 2.2 The wrong-KB problem

v1's CDMSS pipeline retrieves from a single source — MKSAP (internal medicine board prep). For physicians doing clinic-style problem-solving this is fine. For everyone else, retrieval returns irrelevant or misleading content backed by fake-authority citations.

### 2.3 The clinician-model problem

v1's `doctor` table assumes one type of user (URL `/dr-<slug>`, "Attending" line in email template, recipient routing built around physician/clinic patterns). Allied clinicians and the future possibility of nurse practitioners, residents, fellows, technologists doing structured dictation all need a more general primitive.

### 2.4 Strategic context

Even Hospital has dietitians and physiotherapists running scheduled consults today. They generate paper or unstructured digital notes. Extending ETA to them is a high-yield expansion of users with minimal incremental architecture cost — the recording pipeline, transcript pipeline, R2 storage, send pipeline, admin observability, all already work content-agnostically. Only the note-shaping and CDMSS layers need to specialize.

---

## 3. V's Locked Decisions

All architectural and product-shaping decisions for v2.0 are locked. No open questions remain at PRD-level; sprint-level open questions will be raised during each sprint kickoff.

### 3.1 Round 1 — foundation locks (28 May 2026)

| # | Question | Lock | Rationale |
|---|---|---|---|
| Q1 | Clinician table model | New `clinician` table; doctor becomes a `clinician_type` enum | Clean v2 foundation. Migration carries cost but isolates v2 from naming drift forever. |
| Q2 | CDMSS scope per note type | ON for Clinic Encounter + General Medical Note. OFF for Operative/Procedure Note, Dietetic Consult, Physiotherapy Note. | Concentrates CDS where MKSAP-grounded evidence is actually useful. Avoids fake-authority noise on note types where the KB doesn't fit. |
| Q3 | KB strategy | Single `kb_chunks` table with `source` / `discipline` column. Retrieval routes by encounter type. | One pgvector index, one ops surface. Source-tagging lets us add nutrition + rehab + surgical content incrementally without splitting schema. |
| Q4 | Discharge summary | Out of scope for v2.0. Revisit in v2.1 when patient identity model exists. | Requires structured patient-encounter linking which v1 doesn't have. Defer rather than ship a half-baked dictation-only discharge note. |

### 3.2 Round 2 — open-question locks (28 May 2026)

| # | Question | Lock | Rationale |
|---|---|---|---|
| O1 | Op-note sub-specialty handling | Universal schema + auto-extracted `surgical_specialty` field. qwen2.5:14b populates from dictation. Used for admin filtering + email subject; doesn't gate flow. | Sub-specialty-specific schemas are v2.x territory. Universal schema + light specialty tagging gets the inbox-triage value without the complexity. |
| O2 | Multi-procedure modeling | Flat list `procedure_performed: string[]`. Positional convention: first entry is primary, rest are incidental/secondary. Prompt instructs the model accordingly. | Matches how surgeons already dictate. Trivial upgrade path to primary/secondaries object if billing integration ever lands. |
| O3 | Dietetic note recipient routing | Use existing recipient model (per-clinician set + global CCs + ad-hoc per-encounter). No new "primary consultant" picker. | Afshan can pre-set common consultants on her clinician profile. For inpatient rounds with rotating consultants, she adds ad-hoc per encounter. Patient-identity-based routing is a v2.3+ feature. |
| O4 | Email subject format | Note type at start of subject. Format: `[Note type] · [Date] · [Patient] · [Brief topic]`. | Inbox-preview triage is the highest-leverage signal. Type-first wins for multi-clinician multi-type recipient experience. |
| O5 | URL slug pattern | Keep `/dr-<slug>` for ALL clinicians regardless of type. No URL migration. | Demonstrator. "Dr." in the URL means "doctor app" not "this user holds an MD." Zero migration cost. Simplifies Phase E of the data migration too. |
| O6 | Op-note required-to-send fields | Nothing hard-required. Capture fields if dictated, null otherwise. B10 "all sections empty" guard is the only send-blocker. | Demonstrator — no medico-legal gating needed. Soft warnings can land as v2.x polish if testers report incomplete sends. |
| O7 | Notes per recording | One recording → one note type → one encounter. | Clean mental model matching v1. Back-to-back encounters already work in the doctor app for sequential events. "Case sessions" linking multiple encounters belong in v2.3+ with patient identity. |

### 3.3 Round 3 — operational locks (28 May 2026)

| # | Topic | Lock |
|---|---|---|
| L1 | Medico-legal review | Not required. ETA is a demonstrator; production op notes continue to flow through Even Hospital's existing dictation channel. |
| L2 | Pilot dietitian | **Afshan Kamar** (kamar.afshan@even.in), Lead Dietitian, Even Hospital. Workflow context: OPD consults with body composition analysis (likely InBody-style machine output) + daily inpatient rounds on patients under various consultants. Schema must handle both contexts — see §7.2.4 Dietetic schema notes. |
| L3 | Pilot physiotherapist | TBD — to be named before V2.S5 kickoff. |

### 3.4 Round 4 — speaker diarization (28 May 2026, evening IST)

Decisions taken to scope v2.1. Full design in §20.

| # | Question | Lock | Rationale |
|---|---|---|---|
| D1 | Architecture | **Build C** — Deepgram diarize=true on the live WebSocket + Mac Mini pyannote.audio + SpeechBrain ECAPA-TDNN reconciliation at submit. Canonical labeled transcript saved post-submit. | Live UX wins from showing labels from second one; pyannote at submit produces a higher-accuracy canonical record that drives note generation, email, and downstream analysis. Reuses the B7 R2 audio buffer as the pyannote input. |
| D2 | Clinician enrollment | **Onboarding wizard + passive accumulation.** First login (or first login after v2.1 deploy for existing clinicians): 6-sentence read aloud, ~90 sec. Embedding centroid stored. After that, the first 30 sec of every subsequent recording silently refreshes the print. | One-time friction at enrollment, zero per-session friction. Passive refresh keeps the print robust to colds, mic placement, mic upgrades, voice aging. |
| D3 | Role scope | **Patient: numbered (singular per encounter).** **Attender: numbered (Attender 1, 2…).** **Nurse: detected-but-unnamed (singular role label "Nurse").** Only clinicians get named identification. | Patient + attender voice prints are PHI we don't want to retain. Naming 50+ nurses adds enrollment cost without commensurate value — "Nurse" as a role tag is enough context for the note. |
| D4 | Sprint placement | **v2.1 as a clean follow-on release.** v2.0 ships multi-clinician + multi-note-type without diarization. Voice prints captured at enrollment during v2.1 rollout, then live diarization activates once enrollment is complete for the pilot cohort. | Avoids stacking two big mental-model changes on pilots simultaneously. Lets us measure v2.0 quality independent of diarization quality. |
| D5 | Consultation quality scoring scope | **Collect speaker-time aggregates in v2.1; defer rubric + dashboard to v2.2.** v2.1 stores per-encounter clinician/patient/attender/nurse seconds, utterance counts, and average utterance length on the encounter row. No clinician-facing scoring, no dashboard. v2.2 designs the rubric with clinical input and builds the per-clinician dashboard on top of pilot data already collected. | Quality scoring needs proper rubric design + clinical validation that doesn't fit inside V2.SD. Pilot data accumulation must start from day 1 of v2.1 so v2.2 has months of real data to validate against. |

### 3.5 Round 5 — sub-sprint locks (28 May 2026, late evening IST)

Decisions taken during deep-dive on v2.1 implementation details. Full design in §20; this table is the one-line summary so a reviewer can scan all locks in one place. The corresponding §20 sub-sections were updated inline with each lock.

| # | Topic | Lock |
|---|---|---|
| SD-Q7 | pyannote input source | **Canonical audio primary**; whisper-buffer fallback if canonical missing/empty. `/finalize-upload` defers whisper-buffer deletion until the diarize job consumes it (or 1-hour TTL). |
| SD-Q2 | Passive accumulation cadence | **Every recording**; sample drawn from the first 30 s of pyannote-identified clinician speech (not the first 30 s of raw audio). Reuses diarized segments — zero extra compute. |
| Q-A | Live UI before clinician speaks | Status pill "Listening for your voice…" with generic S1/S2/S3 labels; retroactive relabel of matched speaker on first identification. **Live identification threshold 0.78** (higher than batch — see SD-Q1). |
| SD-Q6 | Enrollment gating | **Block /record until enrolled.** Historical bootstrap path for clinicians with ≥10 prior v1/v2.0 encounters (pyannote retro-extracts dominant speaker from existing canonical audio, 30 s confirm step in lieu of full wizard). Super-admin can grant one-time skip. |
| Q-B | Multilingual enrollment | **English-only at enrollment.** Passive accumulation handles Hindi + Kannada from real recordings over time. Cold-start expectation documented in rollout brief. |
| Q-C | Re-enrollment trigger on mic/phone change | **DeviceId change → soft banner** on next /record ("Looks like your mic changed — re-enroll?"). Passive accumulation continues regardless of banner action. |
| SD-Q1 | Batch identification threshold | **Batch 0.70, live 0.78.** Both revalidate at V2.SD.6 against actual EER on 50+ pilot encounters with manually labeled ground truth. |
| SD-Q3 | Manual relabel propagation | Propagate to whole diarized cluster (live + batch). Stored as `manual_relabels JSONB` on encounter. Manual labels always override automatic identification, including high-confidence matches. |
| Q-D | Patient vs. attender disambiguation | Longest cumulative speech = Patient default. **First-person illness statement override** (≥2 statements in EN/HI/KN regex patterns) reassigns Patient role regardless of speech time. Obvious manual relabel UI on /record Speakers panel. V2.SD.6 measures auto-accuracy. |
| SD-Q4 | "Conversation with:" email line | **Off by default**; per-clinician toggle in `/admin/settings` with email preview. Segment-by-segment transcript attachment stays manual-only. |
| SD-Q5 | Re-run diarization permission | **Super-admin only**; confirm modal explains the operation **preserves** `manual_relabels` on re-run. Audit log entry records who triggered. Ops admins can view speaker timelines but not re-run. |
| F-1 | Cross-talk / overlap detection | **pyannote OSD on by default.** Overlapping segments get visible `[Speaker A over Speaker B]` annotation in transcript view. CDMSS excludes overlap-flagged segments from grounding. ~25-35% pyannote runtime overhead (within budget). |
| F-2 | Speakers panel visibility | **Always visible** from second 1 of recording; **collapsed by default** with chevron expansion. Mobile expands as bottom sheet; desktop as dropdown. |
| F-3 | Retroactive diarization of v1 encounters | **Skip entirely.** v1 archive stays unlabeled. Documented as a clean one-time transition; no backfill. |
| F-4 | Op-note speaker model (anesthetist, etc.) | **Defer to v2.x.** Schema comment notes `speakers.type` enum can grow to include `anesthetist` and other clinician sub-roles without a destructive migration. No v2.1 work. |
| F-5 | Recording setup guidance | **Recommend in rollout brief + onboarding tip; do not enforce.** Single sentence: "Place phone on table between you and patient; phone screen up; within 1.5 m of patient's mouth." V2.SD.6 measures whether per-setup accuracy differs enough to tighten guidance in v2.2. |
| F-6 | Admin Speakers tab spec | Gantt timeline with click-to-seek + audio playback **default-muted**; per-speaker stats (cumulative time, % of recording, identification confidence, source flag); **match confidence visible to all admins** (ops + super); super-admin-only re-run button preserving `manual_relabels`. |
| #13 | pyannote license registration | Submit HuggingFace gated-access request **now** as a pending V action — see Carryover. 10-minute form; approval can take 1-2 days; ready well before V2.SD.0 kickoff. |

---

## 4. Scope

### 4.1 In scope (v2.0)

- 5 note types, each with its own schema, prompt, and output: **Clinic Encounter**, **General Medical Note**, **Operative/Procedure Note**, **Dietetic Consult**, **Physiotherapy Note**.
- 3 clinician types: **physician**, **dietitian**, **physiotherapist**. Each can record encounters of compatible note types only.
- New `clinician` table replacing `doctor`. Migration carries existing v1 doctor rows over with `clinician_type='physician'`.
- Note-type picker on the recording screen. Per-clinician-type allow-list.
- Per-note-type LLM prompt + schema + parser.
- CDMSS routing: ON for Clinic + General Medical (existing MKSAP); OFF for Operative + Dietetic + Physio.
- Per-note-type email templates matching the existing Figma design language. Per-note-type subject line and section ordering.
- Per-note-type recipient defaults (e.g., op notes CC the OR coordinator and pathology if specimens were sent).
- Admin surfaces gain note-type and clinician-type filters on Encounters list, Doctors list (renamed Clinicians list), Traces list.
- New v2 onboarding flow: when admin creates a new user, they pick clinician_type.

### 4.2 Out of scope (deferred to v2.1+)

- **Speaker diarization, voice identification, and consultation quality scoring** (now v2.1 — full design in §20).
- Discharge Summary note type (requires patient identity model).
- Hybrid discharge with prior encounter merge.
- Nutrition KB ingestion (Dietetic CDMSS).
- Rehab KB ingestion (Physio CDMSS).
- Surgical KB ingestion (Op-note CDS — post-op risk surveillance module).
- Nurse practitioner, resident, fellow, technologist clinician types.
- ICD-10 / CPT auto-coding.
- HIS / EHR write-back.
- Patient identity model / longitudinal chart.

### 4.3 v2.0 + v2.1 roadmap snapshot

```
v2.0  =  multi-note-type + multi-clinician-type (no new KB content)
v2.1  =  speaker diarization (live + canonical) — see §20            ← NEW
v2.2  =  + nutrition + rehab KBs → CDMSS ON for Dietetic + Physio    ← bumped from v2.1
v2.3  =  + surgical KB → post-op risk surveillance CDS for Op notes  ← bumped from v2.2
v2.4  =  + patient identity model → Discharge Summary                ← bumped from v2.3
v3.0  =  HIS write-back, NPs/residents/fellows, ICD-10/CPT coding
```

Diarization slotted into v2.1 per Round 4 locks (28 May 2026 evening IST, §3.4). Rationale: shipping multi-clinician multi-note-type cleanly first lets pilots Dr. Vinay / Afshan / TBD-physio learn the new mental model without diarization complexity stacked on top. Voice prints get captured during v2.1 enrollment so by the time v2.1 ships, the pilots already have prints registered.

---

## 5. User Personas

### 5.1 Physician — clinic-encounter-focused

Same as v1. Sees note-type picker on recording screen, defaults to Clinic Encounter, occasionally selects General Medical Note (inpatient round, ward consult). Doesn't typically use the Operative/Procedure type unless they're surgical or interventional.

### 5.2 Physician — surgical or procedural

Picks Operative/Procedure Note when dictating after a case. No CDMSS card on output. Different recipient defaults (OR coordinator, anesthesia team, referring physician).

### 5.3 Dietitian

New user type. URL is `/cl-<slug>` (cl for clinician — generic). Sees only Dietetic Consult as the available note type. Schema captures anthropometrics + diet history + diet plan structure. No CDMSS.

### 5.4 Physiotherapist

New user type. Same URL pattern `/cl-<slug>`. Sees only Physiotherapy Note as the available note type. Schema captures functional assessment + rehab plan. No CDMSS.

### 5.5 Admin (super) — Even Hospital ops

Manages all clinician types from one Clinicians list. Filters by type. Sees the same Encounters list with note-type chips alongside the existing send-status chips. Reads traces, manages recipients, etc.

---

## 6. Note Type Matrix

The five note types and their structural attributes:

| # | Note Type | Clinician Types Allowed | CDMSS | KB Source Filter | Email Template | Typical Recipients |
|---|---|---|---|---|---|---|
| 1 | Clinic Encounter | physician | ON | mksap | clinic-encounter | referring + global CCs |
| 2 | General Medical Note | physician | ON | mksap | general-medical | referring + ward team + global CCs |
| 3 | Operative/Procedure Note | physician | OFF (v2.0) | — | operative | OR coordinator + anesthesia + pathology (if specimens) + referring + global CCs |
| 4 | Dietetic Consult | dietitian | OFF (v2.0) | — | dietetic | referring + patient's primary physician + global CCs |
| 5 | Physiotherapy Note | physiotherapist | OFF (v2.0) | — | physiotherapy | referring + patient's primary physician + global CCs |

---

## 7. Schema Design

### 7.1 Database migrations

Five migrations land in v2.0:

**0006_clinician_table.sql** — generalize doctor to clinician.

```sql
CREATE TYPE clinician_type AS ENUM ('physician', 'dietitian', 'physiotherapist');

CREATE TABLE clinician (
  id                text PRIMARY KEY,                   -- cl_<8-char nanoid> (new prefix)
  legacy_doctor_id  text UNIQUE,                        -- migration shim: existing doc_xxxx
  clinician_type    clinician_type NOT NULL DEFAULT 'physician',
  full_name         text NOT NULL,
  email             citext NOT NULL UNIQUE,
  phone             text,
  url_slug          text NOT NULL UNIQUE,
  url_token         text NOT NULL,
  pin_hash          text,
  pin_set_at        timestamptz,
  failed_pin_count  integer NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  session_revoked_at timestamptz,                       -- deferred from v1 backlog
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Migration: copy existing doctor rows into clinician, all with type='physician'.
INSERT INTO clinician (id, legacy_doctor_id, clinician_type, full_name, email, phone,
                       url_slug, url_token, pin_hash, pin_set_at, failed_pin_count,
                       locked_until, created_at, updated_at)
SELECT id, id, 'physician', full_name, email, phone, url_slug, url_token,
       pin_hash, pin_set_at, failed_pin_count, locked_until, created_at, updated_at
FROM doctor;

-- Foreign keys flip: encounter, recipient_per_doctor, llm_traces, audit_log all
-- gain `clinician_id` columns referencing clinician(id). Backfilled from
-- doctor_id. Old doctor_id columns kept temporarily; dropped in 0006c after
-- application code is fully migrated.
```

**0006b_encounter_note_type.sql** — note-type enum + column.

```sql
CREATE TYPE note_type AS ENUM (
  'clinic_encounter',
  'general_medical',
  'operative_procedure',
  'dietetic_consult',
  'physiotherapy'
);

ALTER TABLE encounter
  ADD COLUMN note_type note_type NOT NULL DEFAULT 'clinic_encounter';

-- Existing rows backfill to clinic_encounter (matches v1 behavior).
```

**0006c_kb_chunks_source.sql** — KB source tagging.

```sql
CREATE TYPE kb_discipline AS ENUM (
  'internal_medicine',
  'surgery',
  'nutrition',
  'rehabilitation'
);

ALTER TABLE kb_chunks
  ADD COLUMN source       text NOT NULL DEFAULT 'mksap',
  ADD COLUMN discipline   kb_discipline NOT NULL DEFAULT 'internal_medicine';

CREATE INDEX idx_kb_chunks_discipline ON kb_chunks(discipline);

-- v2.0 ships with only mksap / internal_medicine populated (v1 content).
-- v2.1 + v2.2 will ingest nutrition + rehab + surgery sources.
```

**0006d_recipient_per_clinician_renaming.sql** — recipient_per_doctor → recipient_per_clinician.

```sql
ALTER TABLE recipient_per_doctor RENAME TO recipient_per_clinician;
ALTER TABLE recipient_per_clinician RENAME COLUMN doctor_id TO clinician_id;
```

**0006e_doctor_column_cleanup.sql** — final cleanup. Runs after application code is fully on clinician_id. Drops the old `doctor_id` shim columns and the `doctor` table itself (data already in `clinician`). Reversible via the `legacy_doctor_id` mapping until this migration is applied.

### 7.2 Per-note-type note schemas

Each note type has its own TypeScript type and JSON schema fed to qwen2.5:14b. Shared base type:

```ts
type NoteBase = {
  note_type: NoteType;
  metadata: {
    recorded_at: string;
    clinician_id: string;
    encounter_id: string;
  };
};
```

#### 7.2.1 ClinicEncounterNote (v1 schema, unchanged)

```ts
type ClinicEncounterNote = NoteBase & {
  chief_complaint: string;
  history_present_illness: string;
  past_medical_history: string[];
  current_medications: string[];
  allergies: string[];
  examination: string;
  assessment: string;
  plan: { investigations: string[]; treatment: string[]; follow_up: string };
};
```

#### 7.2.2 GeneralMedicalNote

Designed for inpatient rounds, ward consults, problem-list-style encounters. Similar to clinic but with explicit problem list + active issues + impression-as-of-today.

```ts
type GeneralMedicalNote = NoteBase & {
  reason_for_visit: string;             // why is this clinician seeing the patient today
  active_problems: string[];            // ongoing issues being addressed
  interval_history: string;             // what's happened since last visit / since admission
  current_medications: string[];
  allergies: string[];
  examination: string;
  impression: string;                   // today's clinical synthesis
  plan: {
    investigations_ordered: string[];
    treatment_changes: string[];        // started, stopped, dose-adjusted
    consultations_requested: string[];  // e.g., cards, neuro
    follow_up: string;
  };
};
```

#### 7.2.3 OperativeProcedureNote

Captures the medico-legally required elements of an operative or procedural note. Heavy schema by design — losing fields here has legal consequences.

```ts
type OperativeProcedureNote = NoteBase & {
  procedure_date_time: string;          // ISO if dictated; else free-text
  surgical_specialty: string | null;    // auto-extracted from dictation (O1 lock):
                                        //   "general surgery", "ophthalmology", "orthopedics",
                                        //   "gynecology", etc. Used for admin filtering +
                                        //   email subject. Null if not stated/inferable.
  pre_op_diagnosis: string;
  post_op_diagnosis: string;
  procedure_performed: string[];        // O2 lock: positional convention —
                                        //   procedure_performed[0] = primary procedure
                                        //   procedure_performed[1..] = incidental/secondary
  surgeon: string;                      // primary
  assistants: string[];                 // resident, fellow, etc.
  anesthesiologist: string | null;
  anesthesia_type: string | null;       // GA, regional, MAC, local
  indication: string;                   // why the procedure was performed
  findings: string;                     // intra-op findings
  procedure_narrative: string;          // step-by-step prose
  estimated_blood_loss_ml: number | null;
  fluids_in: string | null;             // free text — "1.5 L NS"
  urine_output_ml: number | null;
  specimens: { description: string; sent_to: 'pathology' | 'discarded' | 'other' }[];
  implants: { description: string; catalog_or_serial: string | null }[];
  drains_placed: string[];
  complications: string;                // free text — "none" if none
  counts_correct: boolean | null;       // sponge/needle/instrument all-correct flag
  antibiotic_given: string | null;      // prophylactic abx + timing
  disposition: string;                  // PACU / ICU / floor / home
};
```

#### 7.2.4 DieteticConsultNote

Captures the structure of a real dietetic consult: anthropometric data, diet history, nutritional assessment, structured diet plan.

**Workflow context (L2 lock):** Afshan's dietitian workflow spans two contexts that share this schema but differ in which fields are typically populated.

- **OPD context** — body composition analysis is often available (full anthropometric set: weight, height, BMI, waist, body fat %, sometimes more from an InBody-class machine). Reason-for-consult and diet plan tend to be detailed.
- **Inpatient rounds context** — anthropometrics may be sparse (often just weight on admission; rarely measured fresh each day on rounds). Reason-for-consult is brief. Diet plan focuses on adjusting an existing inpatient diet (NPO → clear liquids → soft → regular, calorie / macro modifications for diabetic / renal / cardiac diets).

The schema accommodates both — every field is independently optional. The DieteticConsultNoteEditor should display all sections regardless of context; empty sections collapse visually but aren't hidden, so Afshan can quickly add an anthropometric measurement on a rounds note if she happens to have one.

```ts
type DieteticConsultNote = NoteBase & {
  reason_for_consult: string;
  relevant_medical_history: string[];   // DM2, HTN, CKD, etc.
  current_medications: string[];
  allergies_and_intolerances: string[]; // food + drug
  anthropometrics: {
    weight_kg: number | null;
    height_cm: number | null;
    bmi: number | null;
    waist_circumference_cm: number | null;
    body_fat_percent: number | null;
    other: string;                      // free text for any other measurement
  };
  diet_recall: string;                  // typical 24-hour intake
  food_preferences_and_aversions: string[];
  nutritional_assessment: string;       // dietitian's synthesis
  diet_plan: {
    daily_calorie_target_kcal: number | null;
    macronutrient_distribution: string; // "50% CHO / 20% protein / 30% fat" or free text
    meal_pattern: string[];             // typically 3-6 entries: "Breakfast: …", "Mid-morning: …"
    foods_to_emphasize: string[];
    foods_to_limit_or_avoid: string[];
    supplements_recommended: string[];
    behavioural_goals: string[];        // "log meals daily", "walk 30 min/day"
  };
  follow_up: string;                    // when to return + what to track
};
```

#### 7.2.5 PhysiotherapyNote

Captures functional assessment, range of motion, strength testing, rehab plan.

```ts
type PhysiotherapyNote = NoteBase & {
  reason_for_consult: string;
  relevant_medical_history: string[];
  current_medications: string[];
  functional_status_baseline: string;   // pre-injury / pre-illness functional level
  current_functional_status: string;    // today
  pain_assessment: {
    location: string;
    score_0_10: number | null;
    quality: string;
    aggravating_factors: string[];
    relieving_factors: string[];
  };
  rom_findings: string;                 // range of motion summary
  strength_findings: string;            // MMT grade by group, free text
  special_tests: string[];              // e.g., "Lachman positive on right"
  posture_and_gait: string;
  assessment: string;                   // PT's clinical impression + functional dx
  treatment_plan: {
    modalities: string[];               // TENS, ultrasound, IFT, hot/cold
    exercises_prescribed: string[];     // with sets x reps
    home_program: string[];
    precautions: string[];
    expected_outcomes: string;
    sessions_per_week: number | null;
    expected_duration_weeks: number | null;
  };
  follow_up: string;
};
```

### 7.3 KB chunk model

```ts
type KbChunk = {
  id: string;
  text: string;
  embedding: number[];             // pgvector
  source: string;                  // 'mksap', 'sabiston_surgery', 'krause_nutrition', 'kisner_rehab' …
  discipline: KbDiscipline;        // 'internal_medicine' | 'surgery' | 'nutrition' | 'rehabilitation'
  book: string | null;
  chapter: string | null;
  section: string | null;
  page_start: number | null;
  page_end: number | null;
  created_at: string;
};
```

v2.0 KB content state at ship: only `discipline='internal_medicine'` is populated. Other disciplines remain empty until v2.1 / v2.2 ingestion sprints.

---

## 8. LLM Pipeline by Note Type

The transcript pipeline (Deepgram + Whisper + llama3.1:8b cleanup) is **note-type-agnostic** and unchanged from v1. Each note type only differs in (a) the qwen2.5:14b note-generation prompt and (b) whether the CDMSS pipeline runs.

### 8.1 Note generation prompt structure

Each note type has its own SYSTEM prompt. Common framing:

```
You are converting a clinician's voice-dictated patient encounter into
a structured {NoteType}. Use ONLY information explicitly stated in the
transcript — do not invent symptoms, medications, exam findings, doses,
or follow-up plans. If a section was not discussed, return an empty
string or empty array for that field.

Return ONLY a JSON object matching exactly this schema (no preamble,
no markdown fence, no explanation):

{schema}

Style rules:
- Preserve exact medication doses, frequencies, lab values, vital signs
- Use clinical shorthand the clinician used (BD/TDS/QID/PRN/SOB/CP)
- Prefer the clinician's wording over reformulation
- Do not add a diagnosis the clinician didn't state
- If the transcript is too short or non-clinical, fill what you can
  and leave the rest empty
```

The `{NoteType}` and `{schema}` placeholders are substituted per note type. Each prompt adds note-type-specific guidance:

- **ClinicEncounterNote** — same as v1, unchanged.
- **GeneralMedicalNote** — additional guidance to separate active vs. inactive problems, capture interval-history-since-last-visit.
- **OperativeProcedureNote** — explicit guidance: "If EBL is mentioned, capture in ml. If anesthesia type was stated, capture. If specimens are mentioned, capture each separately. If complications were stated as 'none', return that exact string." Plus a checklist of medico-legal required fields the model should look for.
- **DieteticConsultNote** — guidance to capture anthropometric measurements with units, parse the 24-hour diet recall narratively, list food preferences/aversions distinctly, structure the diet plan as a meal pattern rather than a flat treatment list.
- **PhysiotherapyNote** — guidance to capture pain scores numerically when stated, parse ROM findings without forcing numeric grades, list exercises with sets × reps when stated.

### 8.2 Per-note-type pipeline diagram

```
RECORDING:
  doctor app (note_type picked at start)
   ↓
  Deepgram + Whisper + per-utterance cleanup  ← unchanged, content-agnostic
   ↓
  IndexedDB → R2 → /finalize-upload
   ↓
PROCESS:
  /process route reads encounter.note_type
   ↓
  switch (note_type):
    case clinic_encounter:       generateNote_CLINIC()      → run CDMSS (mksap)
    case general_medical:        generateNote_GENERAL()     → run CDMSS (mksap)
    case operative_procedure:    generateNote_OPERATIVE()   → skip CDMSS
    case dietetic_consult:       generateNote_DIETETIC()    → skip CDMSS
    case physiotherapy:          generateNote_PHYSIO()      → skip CDMSS
   ↓
  Persist note_json + cdmss_json (latter null for CDMSS-off types)
   ↓
EMAIL:
  Doctor app shows per-note-type editor → Send
   ↓
  /send picks per-note-type email template
   ↓
  Resend → recipients
```

### 8.3 CDMSS routing

The CDMSS pipeline (HyDE → retrieve → draft → critique → revise → citations) stays structurally identical to v1 but gains discipline-aware retrieval:

```ts
function retrieve(query: string, opts: {
  encounter_note_type: NoteType;
  topK: number;
}): Hit[] {
  const discipline = DISCIPLINE_FOR_NOTE_TYPE[opts.encounter_note_type];
  if (!discipline) return [];  // CDMSS off for this note type
  return pgvectorSearch({
    queryEmbedding: ...,
    where: { discipline },
    limit: opts.topK,
  });
}

const DISCIPLINE_FOR_NOTE_TYPE: Partial<Record<NoteType, KbDiscipline>> = {
  clinic_encounter: 'internal_medicine',
  general_medical: 'internal_medicine',
  // operative_procedure, dietetic_consult, physiotherapy — undefined → no CDMSS
};
```

When discipline maps to a populated KB partition, CDMSS runs the full v1 pipeline. When it maps to an empty partition or to `undefined`, the pipeline emits a single `cdmss_skipped` trace event with reason `discipline_kb_not_populated` or `cdmss_off_for_note_type`, and `cdmss_json` is left null.

### 8.4 CDMSS prompt variations

v2.0 keeps a single CDS drafter prompt (the v1 one). v2.1 will introduce note-type-specific CDS prompts when nutrition and rehab KBs come online (e.g., a "transition-safety check" prompt for discharge summary in v2.3).

---

## 9. UI / UX

All new screens follow the existing Figma design language: navy + neutral palette, Inter typography, AI-violet for CDMSS card, sentence-case headings with numbered sections, the same chip / pill / card primitives. Specifically:

- Color tokens: existing `ink800/700/500/400/100/50`, `navy`, `blue`, `ai50/200/700`, `danger50/200/700`, `white` (extended in B10 fix).
- Type: Inter for body and headings; 11px uppercase tracking-0.14em for section labels; 14px regular for body.
- Components: existing `Section` primitive, AdminShell, Header bars, recipient picker modal.

### 9.1 Recording screen — note-type picker

**Where it lives:** top of the recording screen, immediately below the patient-context strip and above the live transcript.

**Visual:** a horizontal chip row of allowed note types for the signed-in clinician. Selected chip has filled brand-faint background + brand border. Disabled types (not allowed for this clinician type) are not shown (filtered out, not greyed).

**Behavior:**
- Default selection on screen load = clinician's primary note type:
  - Physician → Clinic Encounter
  - Dietitian → Dietetic Consult
  - Physiotherapist → Physiotherapy Note
- Picker locks once recording starts (changing note type mid-recording would require re-running the cleanup LLM with different context, which is too risky). Lock state matches v1's existing "live transcript locked during recording" idiom.
- Helper text below: "What kind of note are you writing?"

### 9.2 Per-note-type encounter editor

Each note type's editor is a server-rendered React component (similar to the existing `EncounterDetailClient` but type-specific). All follow the v4-UI pattern: numbered collapsible Sections, sentence-case headings, flat chip walls for AI-extracted lists, compact inline-edit fields.

#### 9.2.1 ClinicEncounterNote editor — unchanged from v1.

#### 9.2.2 GeneralMedicalNoteEditor

Sections:
1. Reason for visit
2. Active problems (list)
3. Interval history (paragraph)
4. Medications (chips)
5. Allergies (chips)
6. Examination (paragraph)
7. Impression (paragraph)
8. Plan
   - Investigations ordered
   - Treatment changes
   - Consultations requested
   - Follow-up
9. CDMSS card (AI-violet)

#### 9.2.3 OperativeProcedureNoteEditor

Heavy schema → longer editor. Sections:
1. Procedure metadata (date, time, surgeon, assistants, anesthesiologist, anesthesia type)
2. Diagnoses (pre-op, post-op)
3. Procedures performed (list)
4. Indication (paragraph)
5. Findings (paragraph)
6. Procedure narrative (paragraph)
7. Estimated blood loss (numeric input + ml unit)
8. Fluids in (free text)
9. Urine output (numeric)
10. Specimens (list with destination)
11. Implants (list with catalog/serial)
12. Drains placed (list)
13. Complications (free text, defaults "None")
14. Counts (yes/no toggle for "all counts correct")
15. Antibiotic given (free text + timing)
16. Disposition (chip group: PACU / ICU / Floor / Home / Other)

CDMSS card hidden.

#### 9.2.4 DieteticConsultNoteEditor

Sections:
1. Reason for consult
2. Relevant medical history (chips)
3. Medications + allergies/intolerances (two chip groups side by side)
4. Anthropometrics (inline edit pill row: weight, height, BMI auto-calc, waist, body fat %)
5. Diet recall (paragraph — the 24-hour recall)
6. Food preferences and aversions (two chip groups)
7. Nutritional assessment (paragraph)
8. Diet plan
   - Daily calorie target (numeric input)
   - Macronutrient distribution (free text or guided)
   - Meal pattern (list — each entry is "Meal name: description")
   - Emphasize / Limit / Supplements (three chip groups)
   - Behavioural goals (list)
9. Follow-up (paragraph)

CDMSS card hidden in v2.0; will appear in v2.1 after nutrition KB ingestion.

#### 9.2.5 PhysiotherapyNoteEditor

Sections:
1. Reason for consult
2. Relevant medical history (chips)
3. Medications (chips)
4. Functional status (two paragraphs: baseline vs. current)
5. Pain assessment (compact card with location / score / quality / aggravating / relieving)
6. ROM findings (paragraph)
7. Strength findings (paragraph)
8. Special tests (chips)
9. Posture and gait (paragraph)
10. Assessment (paragraph)
11. Treatment plan
    - Modalities (chips)
    - Exercises prescribed (list — "Exercise: 3 sets × 10 reps")
    - Home program (list)
    - Precautions (chips)
    - Expected outcomes (paragraph)
    - Sessions per week + Expected duration (two numeric inputs)
12. Follow-up (paragraph)

CDMSS card hidden in v2.0; will appear in v2.2 after rehab KB ingestion.

### 9.3 Email templates

Each note type gets its own email template variant in `lib/email-template.ts`. All share the existing header chrome (EVEN HOSPITAL pill + note-type badge + IST date strip + PATIENT + CLINICIAN blocks + transcription disclosure banner). The note-type badge text changes:

- Clinic Encounter → "Encounter Note"
- General Medical Note → "Medical Note"
- Operative/Procedure Note → "Operative Note" (or "Procedure Note" depending on procedure type)
- Dietetic Consult → "Dietetic Consult"
- Physiotherapy Note → "Physiotherapy Note"

**Subject line format (O4 lock):** all five types use `[Note type] · [Date] · [Patient] · [Brief topic]`. Type comes first for inbox-triage. Concrete examples:

```
Encounter Note     · 28 May 2026 · Anand Khanna · Chest pain on exertion
Medical Note       · 28 May 2026 · Mrs Reddy    · Type 2 DM follow-up
Operative Note     · 28 May 2026 · Anand Khanna · Laparoscopic cholecystectomy
Dietetic Consult   · 28 May 2026 · Mrs Sharma   · Pre-diabetic diet counselling
Physiotherapy Note · 28 May 2026 · Mr Patel     · Post-op knee rehabilitation
```

The body sections render per-note-type schemas. The B10 empty-content guard (28 May 2026) extends to all five types: if all clinical sections in any schema render empty, the email refuses to send. **Per O6 lock, no other field is hard-required to send** — individual missing fields render as omitted email lines, not blocking errors.

### 9.4 Recipient routing per note type

Per-note-type default recipient sets, configurable in admin Settings:

| Note Type | Defaults |
|---|---|
| Clinic Encounter | global CCs + clinician's referring set |
| General Medical Note | global CCs + ward team alias + clinician's referring set |
| Operative/Procedure Note | global CCs + OR coordinator alias + anesthesia alias + pathology (if any specimen.sent_to='pathology') + referring physician |
| Dietetic Consult | global CCs + patient's primary physician + clinician's referring set |
| Physiotherapy Note | global CCs + patient's primary physician + clinician's referring set |

Implementation: `recipient_global` table gains a `note_types` column (text array) — when null, recipient applies to all types (current behavior); when set, recipient only auto-CC's for the listed types. Allows ops to wire OR-coordinator only on op notes without spamming them on every clinic visit.

### 9.5 Admin surface changes

- **Clinicians list** (renamed from Doctors list at `/admin/clinicians`): adds a clinician-type filter chip row above the existing All/Active/Disabled/Locked filter. Adds a "Clinician type" column.
- **Encounters list** at `/admin/encounters`: adds note-type filter chip row. Adds note-type column.
- **Encounter detail** at `/admin/encounters/[id]`: pipeline strip adapts — operative notes show Recording → Note → Email (no CDS); dietetic + physio show Recording → Note → Email (no CDS); clinic + general show Recording → Note → CDS → Email.
- **Traces list** at `/admin/traces`: filterable by surface (note-pipeline-clinic / note-pipeline-general / note-pipeline-operative / note-pipeline-dietetic / note-pipeline-physio / cdmss-analysis).
- **Settings → Recipients**: per-note-type recipient editor.
- **Settings → Clinicians** (new sub-page): create new clinician with type picker.

---

## 10. KB Ingestion Plan

v2.0 ships with only the existing MKSAP corpus tagged `discipline='internal_medicine'`. The kb_chunks table schema accepts new sources but no content is ingested in v2.0.

### 10.1 v2.1 — Nutrition KB

Target sources (ranked by quality and licensing accessibility):

| Source | License | Content fit | Priority |
|---|---|---|---|
| Krause's Food & the Nutrition Care Process (Elsevier) | Paid | High — gold standard | High |
| ADA / Academy of Nutrition and Dietetics evidence-based guidelines | Free public | Very high — guideline-level | High |
| WHO nutrition guidelines (anemia, micronutrient deficiency, malnutrition) | Free | Medium — population-level | Medium |
| ICMR Dietary Guidelines for Indians 2024 | Free public | Very high — India-specific | High |
| Indian Diabetes Educators Association nutrition modules | Free for educators | High — DM-specific | Medium |

Approach: start with ICMR Dietary Guidelines + ADA + WHO (free, can ingest now), add Krause if licensing budget approved. Chunk by clinical condition (e.g., DM2 + CKD + obesity + pediatric malnutrition + post-bariatric + IBD-specific). Tag `discipline='nutrition'`, `source='icmr_2024'` / `source='ada_guidelines'` / etc.

Volume target: 5,000–15,000 chunks for v2.1 ship. (MKSAP for context is ~25,000 chunks.)

### 10.2 v2.2 — Rehab KB

| Source | License | Content fit | Priority |
|---|---|---|---|
| Kisner & Colby, Therapeutic Exercise | Paid | High — gold standard | High |
| APTA (American Physical Therapy Association) clinical practice guidelines | Free | High — guideline-level | High |
| Indian Association of Physiotherapists guidelines | Free | Medium — India-specific | Medium |
| CPG.PEDro database | Free | High — evidence-based | High |
| Post-op rehab protocols (knee replacement, hip replacement, ACL, rotator cuff) | Free | High — protocol-level | High |

Tag `discipline='rehabilitation'`. Chunk by condition (stroke rehab + post-op orthopedic + pediatric + cardiopulmonary + neurological).

### 10.3 v2.x — Surgical KB (deferred, no firm date)

For surgical CDMSS, the content shape is different — surgeons rarely want differentials post-op. They want:
- Post-op risk surveillance ("for laparoscopic chole, watch for bile leak in first 5 days")
- Standard post-op order sets per procedure
- Specimen handling reminders
- Discharge criteria

This is a different CDS shape than v1's "differentials + red flags + suggestions" and likely needs a separate pipeline. Tag `discipline='surgery'`. Defer until v2.2 ships.

### 10.4 KB ingestion infrastructure

Reusable script `scripts/ingest-kb.ts` that:
1. Accepts a folder of PDF/Markdown source files + a `discipline` + `source` tag.
2. Chunks at heading boundaries (default 500–1500 char target).
3. Generates pgvector embeddings via the same `nomic-embed-text` model the v1 KB uses.
4. INSERTs into `kb_chunks` with discipline + source tags.

Source citations on CDMSS cards continue to use `[N]` superscript style. Sources block at bottom shows the source's full name + chapter + section + page range. Same UI as v1.

---

## 11. Migration Plan (v1 → v2)

The v2 migration is the largest in ETA history because of the doctor → clinician rename. Sequence designed to be zero-downtime:

### 11.1 Phase A — Add the new table (no behavior change)

Migrations 0006 + 0006b + 0006c + 0006d run. `clinician` table exists alongside `doctor`. Foreign keys gain `clinician_id` columns next to existing `doctor_id`. Application still reads/writes via `doctor_id`. **No user-visible change.**

### 11.2 Phase B — Dual-write

Application code updated to write to BOTH `doctor_id` and `clinician_id` on every encounter create. Reads still come from `doctor_id`. Existing data untouched.

### 11.3 Phase C — Backfill

Backfill script populates `encounter.clinician_id` from `encounter.doctor_id` via the `clinician.legacy_doctor_id` mapping. Same for `recipient_per_clinician`, `llm_traces`, `audit_log`.

### 11.4 Phase D — Read-from-new

Application code switched to read from `clinician_id` (and join through `clinician` instead of `doctor`). Dual-write retained as safety net.

### 11.5 Phase E — Drop old

After 1–2 weeks of stable Phase D, migration 0006e drops `doctor_id` columns and the `doctor` table itself. Final state: only `clinician` exists.

**URL slug pattern (O5 lock):** all clinicians — physicians, dietitians, physiotherapists — use the existing `/dr-<slug>` URL pattern. No URL migration. "Dr." in the URL is now interpreted as "doctor app" (the v1 sense), not "this user holds an MD." Phase E of this migration is therefore just "drop the doctor table" — no URL rewriting or legacy aliasing.

### 11.6 Rollback strategy

Each phase has a clear rollback:
- Phase A: drop the migrations.
- Phase B: revert the dual-write code; data in the new columns is duplicated and safe to leave.
- Phase C: backfill is idempotent; re-run if anything corrupts.
- Phase D: switch reads back to `doctor_id`.
- Phase E: irreversible — the only one-way step. Before E, take a manual Neon snapshot.

---

## 12. Sprint Plan

Eight-sprint plan, each sprint ~3–5 days of focused work:

| Sprint | Name | Output | Capstone tag |
|---|---|---|---|
| V2.S0 | Schema foundation | Migrations 0006a/b/c/d applied; clinician table populated; encounter.note_type column added; kb_chunks tagged; doctor table still primary read path | v2-s0-schema-shipped |
| V2.S1 | Clinician model dual-write | Application writes clinician_id alongside doctor_id; admin pages show clinician_type column (read-only display); zero behavior change for existing users | v2-s1-dual-write-shipped |
| V2.S2 | Note-type infra + Clinic + General Medical | encounter.note_type respected in /process; note-type picker on recording screen; GeneralMedicalNote schema + prompt + editor + email template; CDMSS routes via discipline column | v2-s2-clinic-general-shipped |
| V2.S3 | Operative/Procedure Note | OperativeProcedureNote schema + prompt + editor + email template; CDMSS-off path; recipient routing for OR coordinator + anesthesia + pathology | v2-s3-operative-shipped |
| V2.S4 | Dietetic Consult Note | DieteticConsultNote schema + prompt + editor + email template; clinician onboarding for dietitians; ops can create dietitian accounts | v2-s4-dietetic-shipped |
| V2.S5 | Physiotherapy Note | PhysiotherapyNote schema + prompt + editor + email template; physiotherapist onboarding | v2-s5-physio-shipped |
| V2.S6 | Read-from-new migration | Application reads through clinician_id; admin surfaces renamed Clinicians (was Doctors); URLs gain /cl- canonical with /dr- legacy alias | v2-s6-read-migration-shipped |
| V2.S7 | Admin polish + recipient routing | Per-note-type recipient defaults; per-note-type pipeline strip on encounter detail; trace dashboard filters by surface; settings sub-pages updated | v2-s7-admin-polish-shipped |
| V2.S8 | Cleanup + capstone | Drop doctor table (migration 0006e); v2 launch readiness check; soak monitoring; bug-log review | v2-complete |

Total: 8 sprints. Rough calendar (assuming ~3 sprints/week of dedicated dev): 3 weeks if continuous, 6 weeks if part-time.

---

## 13. Success Metrics

Beyond v1's launch-readiness §10.1 metrics (which all continue to apply), v2.0 adds:

| # | Metric | Target | Measurement |
|---|---|---|---|
| 1 | Note-type-pick conversion | ≥99% of recordings have non-null note_type | encounter table count |
| 2 | Allied clinician adoption | At least 2 dietitians + 2 PTs running 5+ encounters each by 30 days post-launch | new clinician account + encounter rollup |
| 3 | Op-note field coverage | ≥80% of operative notes have at least 10 of the 15 schema fields populated | jsonb_object_keys check on note_json |
| 4 | Dietetic anthropometric capture | ≥70% of dietetic notes have at least weight + height populated | note_json check |
| 5 | CDMSS-skip honored | 0 CDMSS pipeline runs on operative / dietetic / physio note types | llm_traces filter |
| 6 | Migration zero-downtime | 0 user-visible disruption during Phase D switchover (5-min canary window) | admin observability |

---

## 14. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| qwen2.5:14b under-extracts on rare note types | Med | High | Few-shot examples in each prompt; explicit "look for these fields" checklist; defensive empty-content email guard already exists (B10) |
| Op-note completeness during testing | Med | Low | Demonstrator only (L1 lock — production op notes flow elsewhere). Note that incomplete dictations will produce notes with null fields; reviewers can edit before sending. B10 guard still blocks all-empty edge case. |
| Doctor → clinician migration data corruption | Low | High | Five-phase migration with rollback at each step; legacy_doctor_id shim retained through E; manual Neon snapshot before E. (Impact downgraded from "Very High" given demonstrator status — no patient data is at irreversible risk.) |
| Dietitians/PTs uncomfortable with empty CDS card | Low | Low | Hide card entirely on CDMSS-off note types; don't show "no CDS available" — the absence is the signal |
| Recipient routing complexity creates bad sends | Med | Med | Default new recipients to "all note types" (current behavior); per-note-type filtering is opt-in via UI. Afshan's inpatient-rounds case (rotating consultants) handled via ad-hoc per-encounter recipient adds (O3 lock). |
| Afshan's inpatient-rounds flow feels slow vs. paper | Med | Med | Make recipient picker chip-based and fast (target 3 taps to add a known consultant). Shadow her workflow before V2.S4 to confirm. |

---

## 15. Resolved Locks (all formerly open)

All seven open questions raised at PRD draft (O1–O7) plus the two operational considerations (L1–L2) were resolved on 28 May 2026 in the same drafting session. Locks now live in §3.2 and §3.3 above. This section is preserved as a changelog.

| # | Resolved on | Decision summary |
|---|---|---|
| O1 | 28 May 2026 | Universal op-note schema + auto-extracted `surgical_specialty` field |
| O2 | 28 May 2026 | Flat list, positional convention (first = primary) |
| O3 | 28 May 2026 | Existing recipient model — no patient-identity auto-routing |
| O4 | 28 May 2026 | Note type at start of subject line |
| O5 | 28 May 2026 | Keep `/dr-<slug>` for all clinicians; no URL migration |
| O6 | 28 May 2026 | Nothing hard-required to send; B10 guard sufficient |
| O7 | 28 May 2026 | One recording → one note type → one encounter |
| L1 | 28 May 2026 | No medico-legal review needed (demonstrator) |
| L2 | 28 May 2026 | Afshan Kamar as pilot dietitian |
| L3 | TBD | Pilot physiotherapist — name before V2.S5 kickoff |

Sprint-level open questions (per-sprint Q-locks during kickoff) will continue to appear in sprint memory docs as in v1.

---

## 16. Appendix A — v2 Backlog (post-v2.0)

In rough priority order:

1. **Nutrition KB ingestion** (v2.1) — ICMR + ADA + WHO ingest; turn on CDMSS for Dietetic
2. **Rehab KB ingestion** (v2.2) — Kisner & Colby + APTA + IAP; turn on CDMSS for Physio
3. **Patient identity model** (v2.3 prereq) — patient_id, MRN, longitudinal encounter linking
4. **Discharge Summary** (v2.3) — depends on patient identity; hybrid dictation + prior-encounter merge
5. **Surgical KB + post-op risk surveillance CDS** (v2.4) — new CDS shape (not differentials but post-op risk timeline)
6. **NPs, residents, fellows, technologists** as additional clinician_types
7. **ICD-10 / CPT code suggestion** on note save (separate model call against note_json)
8. **HIS / EHR write-back** (v3.x)
9. **Multi-language transcription** (v3.x — Hindi, Tamil, Malayalam dictation for India market)
10. **Coach mode** (a v1 backlog item — surgical or clinical decision coaching from CDS)

---

## 17. Appendix B — Specific Prompts (drafts for V's review)

These are first-draft prompts subject to revision during each note-type sprint.

### 17.1 OperativeProcedureNote SYSTEM prompt (draft)

```
You are converting a surgeon's voice-dictated operative or procedure
note into a structured Operative Note. Use ONLY information explicitly
stated in the transcript — do not invent surgical findings, complications,
EBL values, or specimens. If a section was not discussed, return an
empty string or empty array (or null for numeric fields).

Required fields to look for in the dictation:
  - Procedure date and time
  - Pre-operative diagnosis
  - Post-operative diagnosis
  - Procedure(s) performed (list each separately)
  - Primary surgeon
  - Assistants (if any)
  - Anesthesiologist (if mentioned)
  - Anesthesia type (GA, regional, MAC, local)
  - Indication for the procedure
  - Intraoperative findings
  - Procedure narrative (the step-by-step description)
  - Estimated blood loss in ml (numeric)
  - Fluids in
  - Urine output in ml (numeric)
  - Specimens removed (each with destination — pathology, discarded, etc.)
  - Implants used (each with catalog or serial number if stated)
  - Drains placed (list)
  - Complications (use "None" if surgeon explicitly stated none)
  - Counts correct (true / false / null if not mentioned)
  - Antibiotic given (medication + timing)
  - Disposition (PACU / ICU / floor / home / other)

Return ONLY a JSON object matching the OperativeProcedureNote schema
exactly (no preamble, no markdown fence, no explanation).

Style rules:
- Preserve exact medication doses, anesthesia type, fluid volumes
- Use the surgeon's wording for procedure name
- Do not add complications that weren't stated
- If counts were not explicitly addressed, set counts_correct to null
- For implants, prefer "manufacturer + product name + catalog/serial"
  format if stated; otherwise just product name
```

### 17.2 DieteticConsultNote SYSTEM prompt (draft)

```
You are converting a clinical dietitian's voice-dictated patient
consultation into a structured Dietetic Consult Note. Use ONLY
information explicitly stated in the transcript — do not invent
diet recall details, anthropometric values, or dietary preferences.

Required fields to look for:
  - Reason for the consultation
  - Relevant medical history (diabetes, hypertension, CKD, GI disease, etc.)
  - Current medications (especially those affecting weight, appetite, glucose)
  - Allergies and food intolerances (lactose, gluten, nut, etc.)
  - Anthropometrics:
    - Weight in kg (numeric)
    - Height in cm (numeric)
    - BMI (numeric — compute from weight/height if not stated)
    - Waist circumference in cm (numeric, if stated)
    - Body fat percent (numeric, if stated)
  - 24-hour diet recall (capture as a narrative paragraph)
  - Food preferences (foods the patient likes / can eat)
  - Food aversions (foods the patient doesn't like / can't eat)
  - Nutritional assessment (the dietitian's clinical synthesis)
  - Diet plan:
    - Daily calorie target in kcal (numeric)
    - Macronutrient distribution (free text — "50% CHO, 20% protein, 30% fat")
    - Meal pattern (3–6 entries — "Breakfast: ...", "Mid-morning snack: ...")
    - Foods to emphasize
    - Foods to limit or avoid
    - Supplements recommended
    - Behavioural goals (e.g., "log meals daily")
  - Follow-up (when to return, what to track)

Return ONLY a JSON object matching the DieteticConsultNote schema
exactly. If BMI was not stated but weight and height were, compute
BMI = weight_kg / (height_cm/100)^2 and round to 1 decimal.
```

### 17.3 PhysiotherapyNote SYSTEM prompt (draft)

```
You are converting a physiotherapist's voice-dictated patient assessment
into a structured Physiotherapy Note. Use ONLY information explicitly
stated in the transcript.

Required fields to look for:
  - Reason for the consultation
  - Relevant medical history (orthopedic, neurological, cardiopulmonary)
  - Current medications (especially analgesics, muscle relaxants)
  - Functional status — baseline (pre-injury / pre-illness)
  - Functional status — current (today)
  - Pain assessment:
    - Location (body region)
    - Score on 0–10 scale (numeric)
    - Quality (sharp, dull, burning, throbbing, etc.)
    - Aggravating factors (list)
    - Relieving factors (list)
  - Range of motion findings (free text — capture exact degrees if stated)
  - Strength findings (free text — capture MMT grades if stated)
  - Special tests performed and their results
  - Posture and gait observations
  - Assessment (clinical impression + functional diagnosis)
  - Treatment plan:
    - Modalities used today (TENS, ultrasound, IFT, hot/cold pack, etc.)
    - Exercises prescribed (each as "Exercise name: N sets × M reps")
    - Home program (list)
    - Precautions
    - Expected outcomes
    - Sessions per week (numeric)
    - Expected duration in weeks (numeric)
  - Follow-up

Return ONLY a JSON object matching the PhysiotherapyNote schema exactly.
Preserve the physiotherapist's wording for special tests.
```

---

## 18. Appendix C — Recipient Defaults Cheat Sheet

Configurable in Settings → Recipients per note type. Defaults at clinician creation:

```
Clinic Encounter         : [clinician.referring_set] ∪ [global_cc where note_types ⊇ {clinic_encounter}]
General Medical Note     : [clinician.referring_set] ∪ [ward_team_alias] ∪ [global_cc where note_types ⊇ {general_medical}]
Operative/Procedure Note : [clinician.referring_set] ∪ [or_coordinator_alias] ∪ [anesthesia_alias] ∪
                            (specimens_to_path ? [pathology_alias] : []) ∪
                            [global_cc where note_types ⊇ {operative_procedure}]
Dietetic Consult         : [clinician.referring_set] ∪ [global_cc where note_types ⊇ {dietetic_consult}]
Physiotherapy Note       : [clinician.referring_set] ∪ [global_cc where note_types ⊇ {physiotherapy}]
```

The `recipient_global.note_types` column (text[] | null) controls which note types each global CC fires on. `null` = all types (matches v1 behavior so v1 global CCs continue to fire on all v2 note types unless explicitly scoped).

---

## 19. Appendix D — Pilot User Roster

| Clinician | Role | Email | Note types | Workflow contexts |
|---|---|---|---|---|
| V (Vinay Bhardwaj) | Pilot physician (multi-type) | vinay.bhardwaj@even.in | Clinic Encounter, General Medical Note, Operative/Procedure Note | OPD + ward consults |
| Afshan Kamar | Pilot dietitian | kamar.afshan@even.in | Dietetic Consult | OPD (with body comp) + inpatient daily rounds |
| TBD | Pilot physiotherapist | — | Physiotherapy Note | TBD — confirm before V2.S5 |

Two pilot physicians from the v1 test cohort (3 existing test doctors at `eta-v1-complete`) remain available as additional physician testers; V to designate one or two for v2 testing during V2.S2 kickoff.

---

**End of v2.0 PRD.** All decisions locked. Next step on sign-off: convert sections 12 + 7 into concrete sprint V2.S0 PRD with the migration-0006 schema work itemized, then start building.

---

## 20. v2.1 — Speaker Diarization

> Round 4 locks (28 May 2026 evening IST) — see §3.4 for the decision table.

### 20.1 Goal & Value Hypothesis

An OPD encounter is multi-voice. The current ETA pipeline collapses every voice into a single transcript stream, then lets the LLM guess who said what. That fails three ways: (1) the canonical record is ambiguous (was "I've stopped taking it" the patient or the daughter?), (2) downstream analysis can't separate clinician communication patterns from patient-reported facts, and (3) note generation loses provenance — facts ascribed to the patient end up in the note with no way to distinguish them from facts ascribed to family or staff.

v2.1 makes the speaker structure of every encounter a first-class part of the canonical record. Each utterance is attributed to a numbered or named speaker. Clinicians are named (Dr. Vinay, Afshan Kamar). The patient is labeled "Patient" (singular). Family / accompanying speakers are "Attender 1", "Attender 2". Nurses and incidental staff are labeled "Nurse" (no per-nurse identity). The labeled transcript drives note generation, the email body, CDMSS context, and a downstream consultation-quality measurement module (deferred to v2.x — see §20.13).

**Value hypothesis** — three measurable improvements:
1. **Note quality**: per-fact provenance ("Patient denies fever; Attender 1 reports patient had fever yesterday morning"). qwen2.5:14b note prompt is rewritten to use speaker tags as input.
2. **CDMSS grounding**: clinical decision support can distinguish patient-reported symptoms (high weight in differential) from family-reported observations (corroborating signal, different epistemic weight).
3. **Operational analytics**: doctor talk-time ratio, open-ended question frequency, attender involvement, interruption density — all unlocked by speaker-tagged segments. v2.x will build the consultation-quality module on this substrate (§20.13 backlog).

### 20.2 Speaker Model

Every encounter has a `speakers` array. Each element:

| Field | Type | Notes |
|---|---|---|
| `idx` | int | 0-based, stable for the encounter. The transcript_segments reference by idx. |
| `label` | string | Display string. "Dr. Vinay Bhardwaj", "Afshan Kamar", "Patient", "Attender 1", "Nurse". |
| `type` | enum | `clinician` \| `patient` \| `attender` \| `nurse` \| `other` |
| `clinician_id` | string? | Set only when `type=clinician` AND identification succeeded above threshold. References `clinician.id`. |
| `confidence` | float? | Cosine similarity vs. matched centroid (clinicians only). Null for unidentified. |
| `total_speech_sec` | float | Cumulative seconds of speech across all segments. Used for role inference + analytics. |
| `first_heard_at_sec` | float | Seconds from recording start when this speaker first appeared. |
| `manually_relabeled` | bool | True if the clinician overrode the system's assignment during recording or in the editor. |

**Role assignment heuristic** (applied AFTER clinician identification, BEFORE write to DB). Rules are evaluated top to bottom; first match wins.

| # | Rule | Assignment |
|---|---|---|
| 1 | Voice print matches an enrolled clinician with confidence ≥ **0.70** (batch threshold per SD-Q1) | `clinician`, label = clinician.full_name |
| 2 | **Q-D first-person override:** unidentified speaker has ≥ 2 first-person illness statements in transcript (English / Hindi / Kannada regex — see §20.6.2) | `patient`, label = "Patient" |
| 3 | No first-person override; longest cumulative speech time among remaining unidentified | `patient`, label = "Patient" (singular per encounter, per D3) |
| 4 | Second-longest unidentified with ≥ 30 sec speech | `attender`, label = "Attender 1" (or 2, 3…) |
| 5 | Unidentified with < 30 sec total speech AND < 4 turns | `nurse`, label = "Nurse" (singular, per D3) |
| 6 | Anything else | `other`, label = "Other 1" (or 2, 3…) — type enum is forward-compatible (F-4); consumers MUST NOT assert exhaustive type checks |

Heuristic thresholds revalidated at V2.SD.6 against pilot cohort recordings (SD-Q1 + Q-D). Manual relabel always wins — if the clinician taps a speaker badge and chooses a different label, the system records it in `manual_relabels JSONB` and persists across re-runs (SD-Q3 + SD-Q5).

### 20.3 Pipeline Architecture (Build C)

#### 20.3.0 Why pyannote on the Mac Mini, not Whisper-native diarization?

A reasonable question raised during Round 5: doesn't whisper.cpp already do speaker diarization? **No** — and the answer is worth recording here because the question will recur.

Pure Whisper (the OpenAI model, the `ggml-large-v3-turbo` quantization we run via whisper.cpp at `whisper.llmvinayminihome.uk`) is an end-to-end ASR model. It produces text from audio with word-level timestamps. It does not produce speaker labels, does not cluster utterances by speaker, does not hold voice prints. Two features in the ecosystem create confusion:

- **whisper.cpp's `-tdrz` (tinydiarize) flag** emits a `[SPEAKER_TURN]` marker at points where a small auxiliary model thinks the speaker changed. That's a binary "something changed here" signal — no consistent IDs, no who-said-what mapping. Useful as a turn-boundary hint, not a diarization solution.
- **WhisperX** is a Python package marketed as "Whisper with diarization." Internally it's Whisper + **pyannote.audio** + forced alignment glued together. The diarization piece is pyannote. Using WhisperX means installing pyannote (and the gated HuggingFace model) anyway.

So however we package it, real diarization requires adding a model alongside Whisper. The architecture choice is just about how to package:

| Option | What it looks like | Why we didn't pick it |
|---|---|---|
| WhisperX as a single Mac Mini endpoint, replaces whisper.cpp | One Python service handling ASR + diarization + alignment | Loses whisper.cpp's Metal-optimized `ggml-large-v3-turbo` speed. WhisperX runs PyTorch which is slower on Apple Silicon than whisper.cpp's quantized format. We'd have to re-validate latency we already debugged through B6/B7. PyAnnote HuggingFace license still required (it's inside WhisperX). |
| Deepgram batch diarization at submit | Audio goes to Deepgram cloud at submit, we get back speakers + transcript | Breaks the "audio stays local" principle that drove deploying whisper.cpp + qwen2.5:14b locally in the first place. Adds per-minute cost. Diarization accuracy ~85-90% vs pyannote 3.1's ~95%+. Still needs ECAPA on Mac Mini for clinician identification. |
| **whisper.cpp + pyannote as separate Mac Mini endpoints (locked Build C)** | `whisper.llmvinayminihome.uk` keeps doing ASR; new `diarize.llmvinayminihome.uk` runs pyannote + ECAPA-TDNN | Modular: swap either component independently. Whisper.cpp stays fast. Alignment between transcripts is ~30 lines of overlap-join logic in Vercel. Two endpoints to maintain, which is the actual cost. |

The locked Build C is the most modular and respects "audio stays local." If we later decide the two-endpoint footprint isn't worth it, switching to WhisperX is a one-sprint refactor (the `/diarize` endpoint contract stays the same; only the Mac Mini implementation changes).

#### 20.3.1 Live pipeline (Deepgram)

`useDeepgramLive` adds `diarize=true` to its WebSocket open call. Deepgram returns per-word speaker labels (0, 1, 2…) within each utterance. We aggregate at utterance level: the speaker with the most words in the utterance becomes the utterance's `speaker_idx`. This avoids confusing per-word label flips that are common in cross-talk.

The live UI shows utterances with speaker badges. Initial display uses Deepgram's raw indices: "S1 · ...", "S2 · ...". A persistent "Speakers" pill at the top of /record (always visible from second 1, collapsed by default per F-2) shows the status. While no clinician match has been confirmed, the pill reads **"Listening for your voice…"** (Q-A). The system continuously attempts a lightweight match: whenever Deepgram has emitted ≥ 5 seconds of any single speaker's utterances, a short server endpoint runs ECAPA-TDNN inference on that speaker's audio and compares to the logged-in clinician's centroid. On match above the **live threshold of 0.78** (SD-Q1; higher than batch to suppress live mis-attribution), the matched speaker's prior utterances retroactively relabel from "S1" to "Dr. Vinay" and the pill switches to "Identified · Dr. Vinay · 92%".

The clinician can tap any speaker badge during recording and choose from a quick menu: "Mark as Patient", "Mark as Attender", "Mark as Nurse", "Other", "Rename" — manual override. Per SD-Q3, the chosen label applies to all utterances of that diarized cluster (past and future in the same encounter) and persists into the canonical record via `manual_relabels JSONB`.

If the clinician never speaks (or never speaks for long enough to clear the 0.78 threshold), live UI stays at "Listening for your voice…" throughout the recording. The submit-time pyannote pass identifies the clinician retroactively using batch threshold 0.70 (more lenient because pyannote has full-recording context).

#### 20.3.2 Submit-time pipeline (Mac Mini)

On `/finalize-upload`, the **canonical audio file at `encounters/{enc_id}.webm`** is sent to a new Mac Mini endpoint: `https://diarize.llmvinayminihome.uk/diarize` (Cloudflare tunneled, same pattern as the whisper.cpp endpoint). **Per SD-Q7, canonical is the primary input** — it's a single clean MediaRecorder file with no stitch artifacts. If the canonical R2 object is missing or zero-sized (browser submit-time upload failed), the pipeline falls back to the cumulative `whisper-buffer/{enc_id}.webm` and writes a trace event `diarize_used_buffer_fallback`. The `/finalize-upload` whisper-buffer cleanup (added in B7) is deferred until the diarize job consumes the buffer or 1 hour passes — whichever comes first.

The endpoint runs:

1. **pyannote.audio/speaker-diarization-3.1** — input: WebM/Opus audio. Output: list of segments `{start_sec, end_sec, pyannote_label}` where pyannote_label is a free cluster ID like "SPEAKER_00".
2. **pyannote OSD (Overlap Speech Detection)** — same model family, runs in parallel. Output: binary timeline of windows where 2+ speakers overlap. Per F-1, OSD is **on by default** in v2.1 (adds ~25-35% pyannote runtime). Overlapping segments get marked for visible annotation in the transcript view and excluded from CDMSS grounding (see §20.8).
3. **SpeechBrain ECAPA-TDNN** — for each segment, extract a 192-dim float32 embedding. Cluster centroid per pyannote_label.
4. **Identification pass** — cosine similarity of each cluster centroid against every enrolled clinician's stored centroid in `voice_print`. **Batch threshold 0.70** (SD-Q1). Matches above threshold get `clinician_id` assigned.
5. **Role inference** — apply the §20.2 heuristic to unidentified clusters (including Q-D first-person illness override).
6. **Apply manual_relabels** — read encounter row's `manual_relabels JSONB`; for each relabel intent, find the pyannote cluster owning that timestamp range and override the assigned label (manual always wins per SD-Q3).
7. **Segment alignment with Whisper text** — pyannote returns segment boundaries with millisecond precision; Whisper returns text with word-level timestamps. We align by overlap: for each Whisper word, the pyannote segment containing the word's timestamp determines the speaker. Output: `transcript_segments` array.
8. **Compute speaker-time aggregates** (D5) — per-speaker cumulative speech seconds + utterance counts + avg utterance length. Stored on the encounter row for v2.2 consultation-quality dashboard.
9. **Update voice_print via passive accumulation** (SD-Q2) — for the identified clinician, take the first 30 seconds of their clustered speech and add as a new sample to `voice_print.samples_json`, re-average the centroid (rolling cap 20).
10. **Return** to Vercel: `{speakers, transcript_segments, canonical_transcript_text, overlap_windows, aggregates}`.

Vercel writes all into the encounter row. The `canonical_transcript_text` (speaker-tagged, of the form `Dr. Vinay: ...\nPatient: ...`) replaces `transcript_raw` for downstream consumers.

#### 20.3.3 Reconciliation — Deepgram live vs. pyannote canonical

Deepgram and pyannote often disagree on cluster boundaries. Pyannote wins for the canonical record. The Deepgram-labeled live transcript is discarded at submit. Manual relabels made during recording survive via the `manual_relabels JSONB` mechanism above (SD-Q3): each relabel intent stores `{timestamp_ms, source_label, target_label, made_at_ms}` and is applied to the pyannote cluster owning that timestamp in step 6 of the pipeline.

#### 20.3.4 Failure handling

Diarization is a non-critical pipeline stage. If the Mac Mini pyannote endpoint fails or times out, the encounter still completes — `speakers` and `transcript_segments` are left null, `diarize_status='failed'`, and downstream code (note prompt, email template) falls back to the v2.0 unlabeled behaviour. An audit log entry records the failure reason for admin trace dashboard visibility. A nightly job re-attempts diarization on encounters where `diarize_status IN ('failed','pending') AND status='complete' AND created_at > NOW() - INTERVAL '30 days'`. The whisper-buffer fallback (SD-Q7) also engages here: if the canonical audio upload itself failed (canonical missing in R2), the nightly retry reaches for the still-present whisper-buffer.

### 20.4 Voice Enrollment

#### 20.4.1 Onboarding wizard

At first login after v2.1 deploys, every clinician sees a one-screen wizard before the recording UI is enabled. Six sentences are displayed one at a time, each in a clean serif typeface with progress dots above:

```
1. "The quick brown fox jumps over the lazy dog."
2. "She sells seashells by the seashore."
3. "How razorback-jumping frogs can level six piqued gymnasts."
4. "The patient reports intermittent chest discomfort for two weeks."  ← medical register
5. "Heart sounds are normal with no audible murmurs or gallops."        ← medical register
6. "Please follow up in one week with the results of the lab tests."   ← medical register
```

Sentences 1-3 are phonetically diverse (covers most English phonemes). Sentences 4-6 use clinical vocabulary so the print captures the clinician's medical-register prosody. Total enrollment ≈ 90 seconds including pause-and-tap-to-continue between sentences. Per Q-B, the wizard is **English-only at v2.1 launch**; Hindi and Kannada speech enters the centroid through passive accumulation from real recordings (see §20.4.2). A rollout-brief disclosure notes that identification accuracy on code-switching recordings improves over the first 5-10 encounters as multilingual samples accumulate.

Each sentence's audio is sent to the Mac Mini's ECAPA-TDNN endpoint to extract a 192-dim embedding. Six embeddings get averaged into a centroid. Centroid + six samples stored in `voice_print`. The wizard can be re-run from `/cl-<slug>/settings` if a clinician changes their setup (new mic, recovered from prolonged voice illness, etc.).

**Historical bootstrap path (SD-Q6).** Clinicians with ≥ 10 prior v1/v2.0 canonical-audio encounters at the time of first v2.1 /record entry are offered a one-screen alternative: the Mac Mini retroactively runs pyannote across their existing recordings, finds the dominant speaker who introduces themselves with "Hi, I'm Dr…" or similar pattern in the first 10 seconds, extracts the centroid, and asks the clinician to confirm "We've detected your voice from past encounters — is this you?" with a 5-second sample playback. Yes → enrolled in ~30 seconds total. No → fall through to the full 90-second wizard. Super-admin can also grant a one-time enrollment-skip flag for emergency cases (the clinician's encounters skip identification until they enroll later).

#### 20.4.2 Passive accumulation

For every recording post-enrollment, the first 30 seconds of **pyannote-identified clinician speech** (not the first 30 seconds of raw audio — SD-Q2 refinement) is silently re-extracted by the Mac Mini after the submit-time diarization run completes, and added as a new sample to the clinician's `voice_print.samples_json`. Centroid is re-averaged. `sample_count` increments. A rolling cap of 20 samples is maintained — oldest sample is dropped when the cap is hit. This keeps the centroid responsive to gradual voice change without ever requiring re-enrollment friction.

The "clinician-detected speech" framing matters because it handles three common edge cases gracefully:
- The clinician opens recording with 15 seconds of silence as they walk into the room — passive accumulation just waits for them to speak.
- The patient enters mid-sentence and speaks before the clinician — passive accumulation ignores patient utterances.
- The clinician never speaks (rare — chart-review recordings) — no sample added that encounter; voice_print stays as it was.

This also implicitly captures **Hindi and Kannada samples** when the clinician speaks those languages in real encounters (Q-B), avoiding the cold-start problem multilingual enrollment would otherwise create.

Passive accumulation only triggers when the new sample's confidence vs. existing centroid is ≥ 0.55 (lower than the identification threshold). This prevents an unrelated speaker (e.g., a registrar standing in for the clinician but logged in as them) from polluting the centroid.

#### 20.4.3 Re-enrollment triggers

Two mechanisms detect a need to re-enroll:

1. **Mic / phone change (Q-C).** Browser captures `navigator.mediaDevices.enumerateDevices()` deviceId per recording and stores it on the encounter row (`mic_device_id` column, see §20.5). On next /record entry, if the active mic's deviceId differs from the clinician's last 5 recordings' deviceIds, show a dismissible soft banner: "Looks like your microphone changed — want to take 90 seconds to re-enroll for best speaker recognition?" Dismiss → proceed; Tap → re-enroll. Passive accumulation continues regardless of banner action and will catch up over 5-10 recordings if the clinician dismisses.

2. **Gradual drift detection.** A nightly job computes the 30-day moving average of recent match confidences for each clinician's voice_print. If the 30-day average drops below 0.50, the next /record shows a stronger banner: "Quick voice check needed — tap to re-enroll (90 sec)". Hard prompt, but only when the data says it's warranted.

Both banners set `voice_print.needs_reenrollment = TRUE` and are cleared on next successful enrollment completion.

### 20.5 Schema Additions

**Migration 0007a — voice_print table:**

```sql
CREATE TABLE voice_print (
  clinician_id      TEXT PRIMARY KEY
                      REFERENCES clinician(id) ON DELETE CASCADE,
  centroid          BYTEA NOT NULL,           -- 192 floats × 4 bytes = 768 bytes
  sample_count      INT NOT NULL DEFAULT 0,
  samples_json      JSONB NOT NULL DEFAULT '[]'::jsonb,
                                              -- array of base64 sample embeddings (rolling cap 20)
  enrolled_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sample_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  match_confidence_30d_avg FLOAT,             -- nightly job updates
  needs_reenrollment BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_voice_print_needs_reenrollment
  ON voice_print(needs_reenrollment) WHERE needs_reenrollment;
```

**Migration 0007b — encounter columns:**

```sql
ALTER TABLE encounter
  -- Diarization output
  ADD COLUMN speakers             JSONB,
       -- shape: [{idx, label, type, clinician_id?, confidence?, total_speech_sec,
       --          first_heard_at_sec, manually_relabeled, source: 'auto'|'manual'|'historical_bootstrap'}]
       -- NOTE: type enum is forward-compatible (F-4); future values may include
       -- 'anesthetist' / 'co_clinician'. Consumers must not assert exhaustive
       -- type checks.
  ADD COLUMN transcript_segments  JSONB,
       -- shape: [{start_ms, end_ms, speaker_idx, text, overlap?: bool}]
       -- overlap=true marks segments flagged by OSD (F-1); rendered with
       -- '[Speaker A over Speaker B]' annotation and excluded from CDMSS
       -- grounding (§20.8).
  ADD COLUMN overlap_windows      JSONB,
       -- shape: [{start_ms, end_ms, primary_speaker_idx, overlapping_idx[]}]
       -- raw OSD output, used for analytics + admin trace timeline.
  ADD COLUMN manual_relabels      JSONB NOT NULL DEFAULT '[]'::jsonb,
       -- SD-Q3: shape [{timestamp_ms, source_label, target_label, made_at_ms,
       --                actor: 'clinician'|'admin', actor_id}].
       -- Applied to pyannote output in pipeline step 6 (§20.3.2). Survives
       -- super-admin re-runs per SD-Q5.

  -- D5 speaker-time aggregates (consumed by v2.2 consultation-quality dashboard)
  ADD COLUMN aggregates            JSONB,
       -- shape: {clinician_sec, patient_sec, attender_sec, nurse_sec, other_sec,
       --          silence_sec, overlap_sec, utterance_count_by_idx: {0: n, 1: n},
       --          avg_utterance_sec_by_idx: {...}}.

  -- Q-C device tracking for mic-change detection
  ADD COLUMN mic_device_id        TEXT,
       -- navigator.mediaDevices deviceId hash from browser. Used to detect
       -- mic/phone change and trigger soft banner on next /record (§20.4.3).

  -- Diarization pipeline status
  ADD COLUMN diarize_status       TEXT
       CHECK (diarize_status IN
              ('pending','running','complete','skipped','failed')),
  ADD COLUMN diarize_started_at   TIMESTAMPTZ,
  ADD COLUMN diarize_completed_at TIMESTAMPTZ,
  ADD COLUMN diarize_error        TEXT,
  ADD COLUMN diarize_used_buffer  BOOLEAN NOT NULL DEFAULT FALSE;
       -- SD-Q7: TRUE when canonical was missing and whisper-buffer fallback ran.

CREATE INDEX idx_encounter_diarize_status
  ON encounter(diarize_status) WHERE diarize_status IN ('pending','running','failed');
CREATE INDEX idx_encounter_mic_device_id ON encounter(mic_device_id)
  WHERE mic_device_id IS NOT NULL;
```

**Migration 0007d — clinician settings (SD-Q4 toggle):**

```sql
ALTER TABLE clinician
  ADD COLUMN email_show_conversation_with BOOLEAN NOT NULL DEFAULT FALSE;
  -- SD-Q4: clinicians opt in per-account to include the "Conversation with:"
  -- line in their outgoing emails. Toggle in /admin/settings with email preview.
```

**Migration 0007c — audit_log extension:**

```sql
-- Add new audit_log action types (no schema change, just documented)
-- 'voice_print.enroll'           — clinician completed onboarding wizard
-- 'voice_print.refresh'          — passive accumulation updated centroid
-- 'voice_print.reset'            — clinician re-enrolled
-- 'encounter.diarize_complete'   — pyannote pipeline finished
-- 'encounter.diarize_failed'     — pyannote pipeline failed (with error)
-- 'encounter.relabel_speaker'    — clinician manually changed a speaker label
```

### 20.6 Note Generation Prompt Changes

The qwen2.5:14b note prompt today is fed flat `transcript_raw`. v2.1 changes the prompt to be speaker-aware. Two changes:

**Input shape change.** The prompt now receives a JSON-serialized list of `{speaker_label, text}` tuples instead of flat text:

```json
{
  "transcript": [
    {"speaker": "Dr. Vinay", "text": "What brings you in today?"},
    {"speaker": "Patient", "text": "I've been having chest pain for two weeks."},
    {"speaker": "Attender 1", "text": "She's also been very tired in the mornings."},
    ...
  ]
}
```

**Schema change.** Each fact in the structured note gains an optional `attributed_to` field referencing the speaker label:

```json
{
  "chief_complaint": "Chest pain × 2 weeks",
  "history_present_illness": "Patient describes intermittent left-sided chest discomfort...",
  "past_medical_history": [
    {"item": "Hypertension", "attributed_to": "Patient"},
    {"item": "Type 2 diabetes (diagnosed by daughter, confirmation pending)", "attributed_to": "Attender 1"}
  ],
  ...
}
```

Email rendering shows attribution where it changes meaning (PMH items, allergies). Sections like Examination + Assessment + Plan have no attribution (they're the clinician's own findings/judgment).

### 20.7 UI Surfaces

#### 20.7.1 Onboarding voice capture (`/cl-<slug>/onboarding/voice`)

New page, mandatory on first login post-v2.1. Six-sentence wizard with progress dots. Each sentence shows: sentence text in large serif, "Tap to record" button, 5-second progress ring, "Re-record" / "Continue" buttons. Skip button hidden behind a confirm modal ("Your voice won't be identified in recordings until enrollment is complete. Are you sure?").

#### 20.7.2 Live recording — Speakers panel + transcript badges (Q-A + F-2)

LiveTranscript component (already exists, used by /record) gains a per-utterance speaker badge column. Color coding: clinician = primary blue, patient = neutral gray, attender = warm gray, nurse = subtle yellow, overlap-flagged segments get a small `[over]` chip per F-1.

**Speakers pill (always visible from second 1, collapsed by default per F-2).** A persistent pill at the top of the recording screen has three states:

- **State A — pre-identification** (Q-A): pill shows `🎙️ Listening for your voice…` in muted grey while the system hasn't yet matched the logged-in clinician to a Deepgram speaker cluster. Chevron is disabled (no expansion until something is detected).
- **State B — identified, one or more speakers**: pill shows `🎙️ Dr. Vinay · Patient · Attender 1 ▾`. Chevron taps expand the panel.
- **State C — identified, identification confidence shown**: when a speaker is matched to the clinician above the live threshold 0.78 (SD-Q1), the pill briefly animates to highlight the relabel and shows match confidence inline: `🎙️ Identified · Dr. Vinay · 92% · Patient ▾`. Confidence display fades after 5 seconds.

**Expanded panel** (mobile: bottom sheet; desktop: dropdown) shows:
- Per-speaker row: name/role, cumulative speech seconds (live-updating every 5 sec), match confidence (clinicians only), and a tap-to-relabel chevron.
- "+ Mark someone as Patient" affordance (only available if no Patient is currently set — enforces singular-Patient per D3).
- "+ Add Attender" (auto-numbers Attender 1, 2, 3 — D3).
- "↻ Reset all labels" link (clears session-local labels; pyannote at submit will produce fresh assignments).

Tap-to-relabel quick action sheet options: `Rename`, `Mark as Patient`, `Mark as Attender`, `Mark as Nurse`, `Other`, `This isn't anyone — ignore`. Relabel persists locally for the session and is sent with the finalize-upload call as a `manual_relabels[]` entry so the server applies it on top of pyannote output (SD-Q3 + §20.3.2 step 6).

#### 20.7.3 Note editor with speaker-aware view

Two tabs on the encounter detail page: **Note** (current view, structured) and **Transcript** (new, segment-list view with speaker badges). Transcript tab is read-only by default but each segment has an "Edit speaker" affordance — clinician can fix mis-attributed segments before sending. Reassignments propagate to the note JSON's `attributed_to` fields on next note re-render (clinician taps "Regenerate note" if they want the change reflected in the note body too).

#### 20.7.4 Email template (SD-Q4)

Email body **optionally** gets a one-line "Conversation with: Dr. Vinay · Patient · Attender 1 · Nurse" disclosure under the existing "Transcribed from voice" banner. **Off by default**; enabled per-clinician via `/admin/settings → Email preferences → 'Show conversation participants in emails'` (writes `clinician.email_show_conversation_with`). Settings page renders a side-by-side email preview showing the rendered email with and without the line so the clinician can compare before enabling.

Segment-by-segment transcript attachment stays manual-only: the encounter detail page's Send screen has an "Attach full transcript" checkbox per send (defaults unchecked). Useful for medico-legal review of difficult encounters.

#### 20.7.5 Admin trace detail — Speakers tab (F-6 spec)

`/admin/encounters/[id]` gains a new "Speakers" tab next to the existing tabs (Note / Transcript / CDMSS / Send / Audit). Layout:

**Timeline (top of tab)** — Gantt-style horizontal timeline, one row per speaker idx, color-coded bars showing each segment. Time axis below. Click any bar → audio seeks to that timestamp and the Transcript tab scrolls into view at that segment. Right-click a segment → context menu: `Copy timestamp`, `Relabel speaker`, `Show in transcript`. Overlap windows (F-1) marked with a thin red bracket below the Gantt: `⚠ Overlap 02:14-02:18 (Patient over Attender 1)`.

**Audio playback control** — standard media bar with play/pause, seek, current time, total duration. **Default-muted (F-6a)**: admin clicks the speaker icon or hits space to unmute. Keyboard shortcuts: arrow keys = 5 sec seek, J/K = rewind/forward, space = play/pause.

**Speakers panel (below timeline)** — per-speaker row showing:
- Avatar / role icon + name + % of total recording + cumulative seconds + utterance count + avg utterance length
- **Match confidence visible to all admins (F-6b)** — for identified clinicians, `match X.XX` shown next to the name. Ops admins see the same numbers super-admins see.
- Source flag: `✓ Auto` (automatic identification), `Manual relabel by Dr. Vinay at 02:14`, `Heuristic` (role inference rule), `Historical bootstrap` (SD-Q6 path).

**Footer summary** — overlap percentage, pipeline runtime, model version (pyannote 3.1, ECAPA-TDNN), buffer fallback indicator if SD-Q7 fallback triggered, manual relabel count + actor list.

**Super-admin only re-run** (SD-Q5) — `↻ Re-run diarization` button visible only when `admin_user.role = 'super'`. Click → confirm modal: "This re-runs pyannote with the current voice_print state. Manual relabels by the clinician **will be preserved**. The previous diarization output will be overwritten and the regeneration of the note will not happen automatically." Audit log entry records actor + timestamp + the prior `speakers` snapshot.

### 20.8 CDMSS Implications

CDMSS today builds a seed query from CC + HPI + exam + assessment + plan items. With speaker tags, the seed query construction becomes provenance-aware:

- **Patient-reported symptoms** (the patient utterance segments) → weighted highest, treated as primary evidence
- **Attender-reported observations** → included but tagged in the seed: "patient's family member reports: X" — lets the LLM judge corroborative weight
- **Clinician's own examination findings** → already in the structured note; tagged as such
- **Nurse interjections** → excluded from seed (typically logistical, not clinical)
- **Overlap-flagged segments (F-1)** → excluded from grounding. Overlap windows have ambiguous attribution by definition; using them would risk grounding a recommendation on text we can't reliably attribute. Excluded segments are still rendered in the transcript view with the `[Speaker A over Speaker B]` annotation; they just don't feed the seed query.

The CDMSS critique pass also gains a new check: "Did the differential consider the speaker-attribution? Are any flagged symptoms attended-reported only, with no patient corroboration?" — plus an overlap-aware check: "Were any seed inputs sourced from overlap-flagged segments?" (should always be no after the filtering above; the check is a regression guard).

### 20.9 Privacy & Consent

#### 20.9.1 Voice prints are biometric PHI

Per HIPAA's expanded definition (and India's DPDP Act 2023 sensitive-data category), voice biometrics are sensitive identifiers. Storage rules:

- Voice prints encrypted at rest (Postgres column-level encryption via pgcrypto, or Neon's automatic encryption — V to confirm Neon's defaults cover BYTEA columns; if not we add pgcrypto wrappers).
- Voice prints never leave the system — no API exposes the centroid bytes, only match results.
- Voice prints deleted on clinician account deletion (already enforced by `ON DELETE CASCADE`).
- Only clinician's own voice prints stored. Patient/attender/nurse voices are NOT enrolled and their embeddings are not retained post-session (computed in-memory by pyannote during diarization, discarded).

#### 20.9.2 Patient consent disclosure

The doctor app's recording screen gains a one-time disclosure card on first launch post-v2.1: "Recordings may identify different speakers in the room (you, the patient, family members). Speaker labels are kept with the encounter record. Patient and family voice samples are not stored separately." Acknowledged once per clinician account; not per recording.

For the recipient-side email body, the "Transcribed from voice" banner gets extended language: "Speaker attribution provided where identifiable. Manual review recommended for clinically critical statements."

#### 20.9.3 Retention

- `voice_print` rows persist for the lifetime of the clinician account.
- `encounter.speakers` + `encounter.transcript_segments` follow the existing encounter retention policy (PRD v1 §4.17).
- No long-term storage of patient/attender voice embeddings — they exist only in the pyannote in-memory pipeline run.

### 20.10 Sprint Plan — V2.SD

| Sprint | Sub-Sprints | Scope | Estimated effort |
|---|---|---|---|
| **V2.SD.0** | Schema + Mac Mini infra | Migrations 0007a/b/c/d. Mac Mini setup: pyannote.audio 3.1 + **OSD sub-model** (F-1) + SpeechBrain ECAPA-TDNN, Cloudflare tunnel `diarize.llmvinayminihome.uk`, /diarize endpoint accepting WebM with both canonical and buffer-fallback inputs (SD-Q7). Smoke test with a sample recording. **Prereq**: pyannote HuggingFace registration complete (#13). | ~1 sprint (~3 days) |
| **V2.SD.1** | Voice enrollment wizard + historical bootstrap | `/cl-<slug>/onboarding/voice` page, 6-sentence English-only flow (Q-B), Mac Mini ECAPA-TDNN ingest endpoint, voice_print write. Block /record entry: redirect to enrollment if no voice_print row (SD-Q6). **Historical bootstrap path** for clinicians with ≥10 prior canonical-audio encounters (SD-Q6). Super-admin one-time skip flag. | ~4 days |
| **V2.SD.2** | Live diarization + Speakers panel | `useDeepgramLive` adds diarize=true. LiveTranscript renders speaker badges + overlap markers (F-1). Per-utterance speaker aggregation. Speakers pill spec (Q-A + F-2): always visible from second 1, collapsed by default, "Listening for your voice…" → "Identified · Dr. Vinay · 92%" on match. Tap-to-relabel quick action sheet (D3 + SD-Q3). Live identification threshold 0.78 (SD-Q1). Session-local `manual_relabels[]` storage. | ~4-5 days |
| **V2.SD.3** | Submit-time pipeline | /finalize-upload kicks off diarize call. Mac Mini /diarize runs pyannote + OSD + ECAPA-TDNN + identification (batch threshold 0.70 — SD-Q1) + role inference (including Q-D first-person override) + manual_relabel application (SD-Q3) + segment alignment + aggregates (D5). Vercel writes encounter.{speakers, transcript_segments, overlap_windows, manual_relabels, aggregates, diarize_*}. Whisper-buffer fallback when canonical missing (SD-Q7). Fallback to v2.0 unlabeled behaviour on full failure. Nightly re-attempt job. | ~4-5 days |
| **V2.SD.4** | Note prompt rewrite + email | qwen2.5:14b prompt rewritten for speaker-tagged input. `attributed_to` field added to note schema. Email template "Conversation with:" line (SD-Q4 — off by default; per-clinician toggle in /admin/settings with side-by-side preview). Per-fact provenance rendering for PMH/allergies. CDMSS overlap-exclusion (F-1 + §20.8). | ~4 days |
| **V2.SD.5** | Admin Speakers tab (F-6 spec) | `/admin/encounters/[id]` gains Speakers tab with Gantt timeline + click-to-seek + audio playback (default-muted, F-6a). Per-speaker stats with match confidence visible to all admins (F-6b). Overlap-window markers. Super-admin-only re-run button (SD-Q5, preserves manual_relabels). Doctor detail page shows enrollment status + last-match confidence + bootstrap status. | ~3-4 days |
| **V2.SD.6** | Heuristic tuning + EER measurement + pilot smoke + aggregate metrics | Run V2.SD pipeline against 50+ pilot recordings. **Compute EER on pilot data** to validate/adjust SD-Q1 thresholds (0.70/0.78 → ?). Tune §20.2 heuristic incl. Q-D first-person override accuracy. Confirm enrollment friction acceptable. Per-recording-setup accuracy comparison (F-5). Ship encounter.aggregates writes (D5) — values populate but no dashboard yet. CDMSS speaker-aware retrieval if time permits. | ~5-6 days |
| **V2.SD.7** | Passive accumulation + mic-change banner + re-enrollment | Passive 30s-of-clinician-detected-speech refresh on every recording (SD-Q2). DeviceId tracking + soft-banner on mic change (Q-C). Nightly job: 30d match-confidence averages + re-enrollment flag. Re-enrollment banner UI on /record screen. Soft + hard banner variants. | ~3 days |

Total: ~7-8 working weeks. Lands after v2.0 pilot is stable (typically 4-6 weeks of v2.0 pilot use before starting V2.SD).

### 20.11 Success Metrics — v2.1

| Metric | Target | Method |
|---|---|---|
| Clinician identification accuracy | ≥ 95% precision @ 90% recall | Held-out test set of clinician utterances from 50 pilot encounters, manually labeled. |
| Patient vs. attender classification | ≥ 85% agreement with manual ground truth | Same test set, manual labels per non-clinician utterance. |
| End-to-end diarization latency | p50 ≤ 8 sec, p95 ≤ 15 sec | Mac Mini pyannote pipeline timing on 5-minute recordings. Adds to /finalize-upload time budget. |
| Note quality (subjective) | Pilot clinicians rate v2.1 notes ≥ v2.0 notes on attribution clarity | 1-5 rubric, weekly pilot review, n ≥ 30 encounters per clinician. |
| Manual relabel rate | < 15% of utterances | Indicator that the automatic assignment is right most of the time. |
| Enrollment completion rate | 100% of active pilot clinicians within 7 days of v2.1 deploy | Gated by /record entry — should naturally drive completion. |

### 20.12 Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Deepgram diarization mid-stream label flips look glitchy in live UI | Aggregate at utterance level (not word level). Optional "Stable labels" toggle that delays label assignment until utterance ends. |
| pyannote at submit adds 8-15s to clinician's perceived submit time | Run async — return the user to home/library immediately on /finalize-upload, status pill in library shows "Diarization pending". Note generation can start in parallel with diarization (note re-renders after diarization completes for attribution). |
| Cross-talk (two speakers overlapping) | F-1 lock: **pyannote OSD on by default in v2.1.** Overlap-flagged segments get visible `[Speaker A over Speaker B]` annotation in the transcript view and are excluded from CDMSS grounding (§20.8). Note prompt is told overlap exists so the note can flag potentially incomplete medication histories etc. v2.x candidate: targeted second whisper pass on overlap windows for source separation. |
| Pilot clinicians find the enrollment wizard friction unwelcome | Wizard takes ~90 sec, done once. We have already prepared the rationale (per-encounter accuracy gains). Pilot kickoff includes a 2-minute walkthrough demo. If completion lags, fall back to passive-accumulation-only with a banner asking them to enroll when convenient. |
| Voice print drift over months — clinician sounds different from enrollment | Passive accumulation handles this for gradual drift. Nightly re-enrollment flag handles sudden drift (illness recovery, mic change). |
| Patient privacy concern about voice analysis | Disclosure card on first launch post-v2.1. Patient voices never stored as biometric prints. Pyannote runs locally on Mac Mini — patient voice never leaves the hospital network beyond the Vercel → Mac Mini hop. |
| Mac Mini becomes single point of failure for the whole pipeline | Already true for whisper.cpp + qwen2.5:14b. v2.1 doesn't make it worse. v3.0 candidate: cloud-hosted pyannote fallback (e.g., Pyannote AI cloud API) when local fails. |
| pyannote 3.1 license / commercial use | pyannote.audio is MIT-licensed, but the model weights require pyannote AI's HuggingFace gated access + a free non-commercial agreement. **Locked #13: V registers Even Hospital's research-use claim NOW as a pending V action** (see Carryover §13) — well before V2.SD.0 kickoff. 10-minute form, 1-2 day approval. Commercial license available later if Even monetizes ETA externally; flagged in `_sprint0-secrets/`. |

### 20.13 Backlog — deferred from v2.1 (kept here for v2.x planning)

- **Consultation quality scoring dashboard (v2.2)** — Aggregate data is collected in v2.1 per D5 (talk-time ratio, utterance counts, etc.) but the clinician-facing rubric + dashboard is deferred. Design the rubric with clinical input (per specialty, validated against patient outcomes); build the per-clinician dashboard with longitudinal trends. Separate PRD round.
- **Anesthetist / co-clinician speaker support (v2.x, F-4)** — Add `anesthetist` to the `speakers.type` enum. Anesthetists enroll via the same wizard as physicians. Op notes auto-include anesthesia team in recipient defaults. Schema is forward-compatible per the comment in §20.5 — no migration needed when this lands.
- **Overlap-recovery whisper pass (v2.x, F-1 extension)** — When OSD flags overlap, run a targeted second whisper.cpp pass on the overlap window with prompting to surface the quieter speaker's text. Whisper isn't built for source separation, so this is research-grade — measure quality before committing.
- **Mic-setup gating (v2.x, F-5 escalation)** — If V2.SD.6 data shows recording-setup accuracy variance is large enough to matter, detect audio levels at recording start and warn on phone-in-pocket configurations. Until then, recommend-don't-enforce holds.
- **Nurse identification by name** — enrollment wizard for Even Hospital's nursing staff. Pushed beyond v2.1 because of enrollment-management overhead. D3 keeps `Nurse` as a singular detected-but-unnamed role.
- **Per-speaker editing in the note editor** — current design is read-only segment view. v2.x could let the clinician edit a segment's text + re-attribute, with note re-render. Bigger UX investment.
- **Speaker-tagged structured search** — "show me all encounters where Attender 1 reported a symptom" — admin analytics use case. Needs `transcript_segments` to be denormalized into a queryable form.
- **Cross-encounter voice tracking for the same patient** — only meaningful with the v2.4 patient identity model. Could let us recognize a returning patient's voice without enrollment. PHI-sensitive — likely needs explicit consent flow.

### 20.14 Open Questions — RESOLVED via Round 5 locks (28 May 2026)

All seven original SD-Q items plus four new questions surfaced during the deep-dive (Q-A through Q-D) plus six follow-up topics (F-1 through F-6) are now locked. See §3.5 for the consolidated lock table; the relevant §20 sub-sections were updated inline above. No open questions remain at PRD level.

The remaining open items live at sprint-kickoff scope (e.g., how to lay out the Speakers panel's bottom-sheet on small viewports; pyannote model storage path on the Mac Mini; exact phrasing of the "Listening for your voice…" pill). These are implementation details, not design decisions.

---

**End of v2.1 PRD addendum.** All Round 4 (D1-D5) and Round 5 (SD-Q1-Q7, Q-A-Q-D, F-1-F-6, #13) locks captured. Next step on sign-off: complete the pyannote HuggingFace registration as a pending V action; at v2.0 pilot stability (~4-6 weeks post-V2.0 launch), kick off V2.SD.0 with the Mac Mini infra setup and migration-0007a, then walk through the sub-sprints in order.
