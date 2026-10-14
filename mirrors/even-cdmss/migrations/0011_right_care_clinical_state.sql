-- 0011_right_care_clinical_state — Right Care × ClinicalState (Slice 1).
-- (a) appropriateness_runs grows two NULLABLE columns: the constructed ClinicalState
--     (DE-IDENTIFIED — built only from the run's own de-identified input; carries no
--     name/UHID/MRN/DOB) and its schema version. Additive + idempotent; every existing
--     row and writer is untouched.
-- (b) record_audit_member_links — the member linkage key for Record-audit runs, in a
--     PHYSICALLY SEPARATE table (privacy discipline: identity is stored ALONGSIDE the
--     clinical record, never inside it). member_link holds the raw identity extracted
--     FOR LINKAGE ONLY from the uploaded document ({uhid?, mrn?, name?, dob?}) by a
--     dedicated identity-only pass; resolved_individual_uid stays NULL until the
--     identity-bridge work resolves it downstream. Writes are dark behind
--     RIGHT_CARE_CLINICAL_STATE=1 + RECORD_AUDIT_LINK=1 (both default OFF).

ALTER TABLE appropriateness_runs ADD COLUMN IF NOT EXISTS clinical_state         JSONB;
ALTER TABLE appropriateness_runs ADD COLUMN IF NOT EXISTS clinical_state_version TEXT;

CREATE TABLE IF NOT EXISTS record_audit_member_links (
  run_id                  TEXT PRIMARY KEY REFERENCES appropriateness_runs(id) ON DELETE CASCADE,
  member_link             JSONB NOT NULL,          -- { uhid?, mrn?, name?, dob? } — identity for linkage ONLY
  resolved_individual_uid TEXT,                     -- NULL until resolved by the downstream identity bridge
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
