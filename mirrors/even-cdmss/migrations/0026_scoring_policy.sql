-- 0026_scoring_policy — governed NABH completeness weightage (Phase A of
-- CDMSS-SCORING-POLICY-NABH-WEIGHTAGE-PRD-AND-KICKOFF-27-JUL-2026, §3).
--
-- ⚠️ RENUMBERED FROM 0014. The PRD names this migration `0014_scoring_policy.sql`, but 0014 through
-- 0025 are already applied in this repo (0014_ipd_audit_report_feedback, … 0025_opd_note_audits_scorecard).
-- 0026 is the next free number. Phase B's `0015_review_notes.sql` will need the same treatment.
--
-- ADDITIVE AND IDEMPOTENT throughout (the 0013 house style): CREATE TABLE IF NOT EXISTS, CREATE
-- INDEX IF NOT EXISTS, and a seed guarded by NOT EXISTS so re-running cannot duplicate v1.
--
-- NOTHING IS ALTERED. No column is added to ipd_discharge_audits or opd_note_audits: weighted
-- scores are DERIVED ON READ (decision §1.1), never stored, so no historical row is ever mutated.
-- Rolling this migration back leaves every existing score exactly as it is today.

-- ── published, immutable versions ───────────────────────────────────────────────────────────────
-- Append-only. A "restore" publishes a NEW version carrying the old weights forward (PRD §5.5);
-- history is never rewritten.
CREATE TABLE IF NOT EXISTS scoring_policy_versions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_type         TEXT NOT NULL,              -- 'discharge_summary' | 'opd_rx' (Phase C adds 'lab_packages')
  version           INT  NOT NULL,              -- monotonic per note_type; renders as nabh-weights/<note_type>/<version>
  weights           JSONB NOT NULL,             -- { "<field key>": "critical|important|standard|minor" }
  weights_sha256    TEXT,                       -- sha256 of the canonical (key-sorted) vector
  rationale         TEXT NOT NULL,              -- MANDATORY written reason (decision §1.3)
  published_by      TEXT,
  published_by_name TEXT,
  published_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active         BOOLEAN NOT NULL DEFAULT FALSE,
  supersedes        INT,                        -- the version this replaced; NULL for v1
  app_source        TEXT NOT NULL DEFAULT 'standalone',
  UNIQUE (note_type, version)
);

-- Exactly one active version per note type. A partial unique index is the right shape here: it
-- constrains only the active rows and leaves the superseded history unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS scoring_policy_versions_one_active
  ON scoring_policy_versions (note_type) WHERE is_active;

CREATE INDEX IF NOT EXISTS scoring_policy_versions_note_type_version
  ON scoring_policy_versions (note_type, version DESC);

-- ── the shared working draft ────────────────────────────────────────────────────────────────────
-- One draft per note type (PRD §8.6 — concurrent editing is resolved by comparing updated_at on
-- publish, not by locking).
CREATE TABLE IF NOT EXISTS scoring_policy_drafts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_type   TEXT NOT NULL UNIQUE,
  weights     JSONB NOT NULL,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  app_source  TEXT NOT NULL DEFAULT 'standalone'
);

-- ── seed v1 — every field on Standard ───────────────────────────────────────────────────────────
-- PRD §3: "Migration must seed v1 per note type with every field on Standard, rationale
-- 'Initial — equal weight across all fields, reproduces legacy scoring.', published_by_name =
-- 'System', is_active = true."
--
-- All-Standard is the identity element of the weighting: §2.3 reduces algebraically to the legacy
-- flat proportion, so seeding v1 changes NO score anywhere. That is the property PRD §2.5 makes the
-- ship gate, and it is why this seed is safe to run on production before anyone opens the screen.
--
-- The 21 discharge_summary keys are VERBATIM from data/nabh-rubric.json (PRD §2.9).
-- The 13 opd_rx keys are the OPD engine's own item keys (lib/opd-note-audit-core.ts), EXCLUDING the
-- three continuity fields (advice_given, advice_instructions, follow_up), which are scored in the
-- Continuity domain and must never carry a completeness weight.

INSERT INTO scoring_policy_versions (note_type, version, weights, rationale, published_by_name, is_active, supersedes)
SELECT 'discharge_summary', 1, '{
  "patient_name":"standard","uhid":"standard","treating_doctor":"standard",
  "date_admission":"standard","date_discharge":"standard","reason_admission":"standard",
  "significant_findings":"standard","diagnosis":"standard","condition_at_discharge":"standard",
  "investigations":"standard","procedures_performed":"standard","medications_administered":"standard",
  "treatment_given":"standard","followup_advice":"standard","discharge_medication":"standard",
  "patient_instructions":"standard","urgent_care_instructions":"standard","outcome":"standard",
  "cause_of_death":"standard","doctor_signature":"standard","signed_datetime":"standard"
}'::jsonb, 'Initial — equal weight across all fields, reproduces legacy scoring.', 'System', TRUE, NULL
WHERE NOT EXISTS (
  SELECT 1 FROM scoring_policy_versions WHERE note_type = 'discharge_summary' AND version = 1
);

INSERT INTO scoring_policy_versions (note_type, version, weights, rationale, published_by_name, is_active, supersedes)
SELECT 'opd_rx', 1, '{
  "presenting_complaint":"standard","presenting_complaint_symptoms":"standard",
  "relevant_history":"standard","examination":"standard","vitals":"standard",
  "diagnosis":"standard","allergy_status":"standard","medication_dosing":"standard",
  "investigations":"standard","obstetric_vitals":"standard","gravidity_parity":"standard",
  "lmp_edd":"standard","ga_pog":"standard"
}'::jsonb, 'Initial — equal weight across all fields, reproduces legacy scoring.', 'System', TRUE, NULL
WHERE NOT EXISTS (
  SELECT 1 FROM scoring_policy_versions WHERE note_type = 'opd_rx' AND version = 1
);
