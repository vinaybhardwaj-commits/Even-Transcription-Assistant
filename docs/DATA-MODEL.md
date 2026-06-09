# ETA / Evenscribe — Data Model

Schema authority: `db/schema.ts` (Drizzle), but **raw SQL is used everywhere** at runtime via the
Neon HTTP driver. Canonical migrations: `db/migrations/NNNN_name.sql`, applied idempotently via
`POST /api/run-migrations` (Bearer `MIGRATION_SECRET`). Two databases: **APP** (below) and **KB**
(read-only pgvector knowledge base, `KB_DATABASE_URL`).

## Tables (APP DB)

| Table | Purpose |
|---|---|
| `clinician` | **Sole identity table.** Doctors/dietitians/physiotherapists. PIN (bcrypt + `pin_plaintext` for super-admin visibility), slug, `clinician_type`, last_active. Replaced `doctor` (dropped in 0015; ids preserved). |
| `admin_user` | Admin logins (UUID id, bcrypt password, role `super`). |
| `pin_attempt` | PIN lockout / rate-limit tracking. |
| `encounter` | Core record: status (`draft`/`processing`/`complete`/`failed`/`draft_partial`/`deleted`), `note_type`, `note_json` + `note_json_edited`, `cdmss_json`, transcripts (`transcript_raw`/`_original`/`tagged_transcript`), `detected_language`, audio (`audio_object_key`/`audio_bytes`/`duration_seconds`), diarization fields, send status. |
| `recipient_global` / `recipient_per_doctor` | Email recipient books. |
| `send_event` | Email send + Resend webhook delivery lifecycle. |
| `trace` / (LLM traces) | Pipeline/LLM observability. |
| `voice_print` | Per-clinician averaged voice centroid + per-clip embeddings (diarization naming). |
| `voice_sample` | Retained per-clip embedding + R2 audio ref; source `enrollment`/`passive`; partial-unique on passive (0024). |
| `settings` | Key/value app settings. |
| `audit_log` | Security/audit events (logins, audio access, admin actions). |
| **STT Engine Lab** | `stt_engine` (registry rows), `stt_fanout_job` (offline queue; `started_at` for atomic claim, 0025), `transcription_run` (per-engine ASR/scribe results + scores), `stt_gold` (verbatim references for WER), `stt_lab_config`, `stt_routing` (stage×language engine routing). |
| `doctor` | **Deprecated** — declared in schema.ts but dropped in prod (0015). Do not use. |

## Migrations (0001–0026; 0013 intentionally skipped)

| # | Name | What |
|---|---|---|
| 0001 | init | base schema (encounters, doctor, recipients, sends, audit) |
| 0002 | llm_traces | LLM trace storage |
| 0003 | note_edited | `note_json_edited` |
| 0004 | encounter_status_draft_partial | `draft_partial` status (cancel mid-process) |
| 0005 | launch_readiness_attestation | launch checklist |
| 0006 | multilingual_transcription | `transcription_run`, `detected_language`, `transcript_original` |
| 0007 | diarization | `voice_print` + encounter diarize columns |
| 0008 | identification_label | diarization EER ground-truth labels |
| 0009 | tagged_transcript | speaker-tagged transcript |
| 0010 | clinician_table | `clinician` (copied from doctor) |
| 0011 | encounter_note_type | `note_type` |
| 0012 | clinician_backfill | refresh clinician from doctor |
| 0014 | repoint_fks | FKs encounter/voice_print/recipient_per_doctor/pin_attempt → clinician |
| 0015 | drop_doctor | **DROP TABLE doctor** (clinician is sole identity) |
| 0016 | clinician_pin_plaintext | super-admin PIN visibility |
| 0017 | voice_sample | retained voice samples (audio + embedding) |
| 0018 | stt_engine | STT Engine Lab registry (+ seed engines) |
| 0019 | stt_fanout | offline fan-out queue |
| 0020 | stt_gold | gold set for WER / term fidelity |
| 0021 | stt_routing | stage×language routing table |
| 0022 | stt_even_pipeline | `even_pipeline` virtual scribe competitor |
| 0023 | ekascribe_scribe_only | EkaScribe = scribe tier only |
| 0024 | voice_sample_passive_unique | partial-unique index on passive samples |
| 0025 | stt_fanout_started_at | `started_at` for atomic drain claim |
| 0026 | elevenlabs_scribe | disable EkaScribe; add `elevenlabs_scribe` scribe engine |

## 5 note types (by `encounter.note_type`)

`clinic` (default), `general_medical`, `operative_procedure`, `dietetic_consult`, `physiotherapy`.
Each has a distinct JSON schema, generator prompt, viewer, editor, and email template. CDS runs only
for note types where it's clinically relevant (`noteTypeHasCdmss()`); operative/dietetic/physio skip it.
